/**
 * The CatSpec MCP server (plan §D14), PBIs `mcp-server-core`, `mcp-tools` and
 * `mcp-resources-and-prompts`: `catspec mcp` serves it on stdio.
 *
 * - Tools (§D14.1): see `./tools.ts`.
 * - Resources (§D14.2): `catspec://spec/{id}` (the raw spec file), `catspec://architecture` (the
 *   ADR log), `catspec://graph` (mermaid) and `catspec://diagnostics` (the last check, as JSON).
 * - Prompts (§D14.2): `implement-spec` and `fix-drift`.
 */
import { createRequire } from "node:module";

import { checkCode, SPEC_STATUSES } from "@catspec/core";
import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

import {
  checkCompliance,
  checkDependencies,
  findSpec,
  findSpecsForFile,
  getSpecContext,
  listSpecs,
  setSpecStatus,
  startRefactor,
  syncSpecs,
  updateSpecBindings,
  Workspace,
  type ToolOutput,
  type WorkspaceOptions,
} from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const INSTRUCTIONS =
  "CatSpec checks code against specs (docs/spec/<feature>/<id>.spec.md). To implement a spec: " +
  "get_spec_context, check_dependencies, set_spec_status in-progress, write the code, then " +
  "check_compliance until done is true, then set_spec_status implemented. Never weaken a " +
  "contract to make a check pass: update_spec_bindings only proposes contract edits; show the " +
  "proposal to the developer.";

/** A tool's answer as an MCP result: the text, and the same facts as structured content. */
const result = (output: ToolOutput): CallToolResult => ({
  content: [{ type: "text", text: output.text }],
  structuredContent: output.data,
});

const specId = z.string().min(1).describe("the spec id (see list_specs)");
const status = z.enum(SPEC_STATUSES);

/** An MCP server for the repository at `options.root`. */
export function createServer(options: WorkspaceOptions): McpServer {
  const ws = new Workspace(options);
  const server = new McpServer(
    { name: "catspec", version },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "list_specs",
    {
      description:
        "List the specs: id, title, status, dependencies (satisfied or not) and task progress.",
      inputSchema: z.object({
        status: status.optional().describe("only specs with this status"),
        ready_only: z
          .boolean()
          .optional()
          .describe("only specs ready to start: status ready, dependencies implemented"),
      }),
      annotations: readOnly,
    },
    async (input) => result(await listSpecs(ws, input)),
  );

  server.registerTool(
    "get_spec_context",
    {
      description:
        "Everything needed to implement a spec: its Markdown body, the contract (bindings, " +
        "members, rules by class), dependency status, infrastructure, the files its bindings " +
        "resolve to, the architecture rules that apply, and its current compliance.",
      inputSchema: z.object({ spec_id: specId }),
      annotations: readOnly,
    },
    async (input) => result(await getSpecContext(ws, input)),
  );

  server.registerTool(
    "check_compliance",
    {
      description:
        "Check code against specs. With spec_id: that spec as if implemented. With file_path: " +
        "every spec bound to the file. With neither: the whole repository, by spec status. " +
        "Returns done (no errors) and every diagnostic with expected, found and a fix. Call " +
        "it after each change until done is true.",
      inputSchema: z.object({
        spec_id: specId.optional(),
        file_path: z.string().min(1).optional().describe("a file in the repository"),
        staged: z.boolean().optional().describe("check the git index instead of the working tree"),
      }),
      annotations: readOnly,
    },
    async (input) => result(await checkCompliance(ws, input)),
  );

  server.registerTool(
    "find_specs_for_file",
    {
      description: "The specs that bind or scope a file, and how (binding id or scope).",
      inputSchema: z.object({
        file_path: z.string().min(1).describe("a file in the repository"),
      }),
      annotations: readOnly,
    },
    async (input) => result(await findSpecsForFile(ws, input)),
  );

  server.registerTool(
    "check_dependencies",
    {
      description:
        "Each dependency of a spec: its status, whether it is satisfied (implemented and " +
        "passing) and its failing items.",
      inputSchema: z.object({ spec_id: specId }),
      annotations: readOnly,
    },
    async (input) => result(await checkDependencies(ws, input)),
  );

  server.registerTool(
    "update_spec_bindings",
    {
      description:
        "Edit a spec's bindings with a patch keyed by binding id: each value is a JSON merge " +
        "patch of that binding (null removes a key), null removes the binding, a new id adds " +
        "one. Returns the diff. A dry run unless dry_run is false. Location edits (symbol, " +
        "file) can be applied; contract edits are only returned as a proposal for the " +
        "developer unless mcp.allow_contract_edits is true.",
      inputSchema: z.object({
        spec_id: specId,
        patch: z
          .record(z.string(), z.unknown())
          .describe('e.g. { "service": { "symbol": "AuthService" } }'),
        dry_run: z.boolean().default(true),
      }),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => result(await updateSpecBindings(ws, input)),
  );

  server.registerTool(
    "set_spec_status",
    {
      description:
        "Change a spec's status (draft, ready, in-progress, implemented, deprecated) with the " +
        "lifecycle rules: in-progress and implemented need the dependencies implemented and " +
        "passing; implemented is refused while the spec's contracts fail. Optional links " +
        "(pr, issue, commit) are recorded in the spec.",
      inputSchema: z.object({
        spec_id: specId,
        status,
        links: z
          .object({
            pr: z.union([z.string(), z.number()]).optional(),
            issue: z.union([z.string(), z.number()]).optional(),
            commit: z.string().optional(),
          })
          .optional(),
      }),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => result(await setSpecStatus(ws, input)),
  );

  server.registerTool(
    "start_refactor",
    {
      description:
        "Start a large refactor (many renames or moves): records where every binding in the " +
        "scope resolves now. Finish it with sync_specs.",
      inputSchema: z.object({
        scope: z.array(z.string()).optional().describe("globs of the files in the refactor"),
        reason: z.string().optional(),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await startRefactor(ws, input)),
  );

  server.registerTool(
    "sync_specs",
    {
      description:
        "Find renamed and moved code of the specs' bindings and fix the specs' locations " +
        "(symbol and file, never the contract). Returns the mapped, ambiguous and lost " +
        "bindings; a dry run unless dry_run is false. During a refactor it maps every binding " +
        "of the refactor and ends it.",
      inputSchema: z.object({
        map: z
          .object({
            symbols: z.record(z.string(), z.string()).optional(),
            namespaces: z.record(z.string(), z.string()).optional(),
            paths: z.record(z.string(), z.string()).optional(),
          })
          .optional()
          .describe("old name → new name, for bindings the detection can't map"),
        dry_run: z.boolean().default(true),
        partial: z
          .boolean()
          .optional()
          .describe("apply what is mapped even if some bindings are ambiguous or lost"),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await syncSpecs(ws, input)),
  );

  // Resources -------------------------------------------------------------------------------

  server.registerResource(
    "spec",
    new ResourceTemplate("catspec://spec/{id}", {
      list: async () => {
        const model = await ws.model();
        return {
          resources: model.specs.all().map((s) => ({
            uri: `catspec://spec/${s.id}`,
            name: s.id,
            title: s.title,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    { description: "A spec file, as it is on disk", mimeType: "text/markdown" },
    async (uri, variables) => {
      const model = await ws.model();
      const id = decodeURIComponent(String(variables.id));
      const spec = model.specs.get(id);
      if (!spec) throw new ResourceNotFoundError(uri.href);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: spec.source.text }] };
    },
  );

  server.registerResource(
    "architecture",
    "catspec://architecture",
    {
      description: "The architecture spec: global rules in the frontmatter, the ADR log below",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const model = await ws.model();
      if (!model.architecture) throw new ResourceNotFoundError(uri.href);
      return {
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: model.architecture.source.text },
        ],
      };
    },
  );

  server.registerResource(
    "graph",
    "catspec://graph",
    { description: "The dependency graph of the specs (mermaid)", mimeType: "text/plain" },
    async (uri) => {
      const model = await ws.model();
      return {
        contents: [
          { uri: uri.href, mimeType: "text/plain", text: ws.engine.formatGraph(model.graph) },
        ],
      };
    },
  );

  server.registerResource(
    "diagnostics",
    "catspec://diagnostics",
    {
      description: "The diagnostics of the last check (the whole repository if none ran yet)",
      mimeType: "application/json",
    },
    async (uri) => {
      if (!ws.last) {
        const model = await ws.model();
        const check = await checkCode(model, await ws.codebase(model.config));
        ws.last = {
          at: new Date().toISOString(),
          specs: check.checked.map((s) => s.id),
          done: !check.diagnostics.some((d) => d.severity === "error"),
          diagnostics: check.diagnostics,
        };
      }
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(ws.last, null, 2) },
        ],
      };
    },
  );

  // Prompts ---------------------------------------------------------------------------------

  const promptArgs = z.object({ spec_id: z.string().describe("the spec id") });
  const user = (text: string) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  });

  server.registerPrompt(
    "implement-spec",
    { description: "Implement a spec until CatSpec says it is done", argsSchema: promptArgs },
    async ({ spec_id }) => {
      findSpec(await ws.model(), spec_id);
      return user(
        [
          `Implement the CatSpec spec "${spec_id}".`,
          "",
          `1. Call get_spec_context with spec_id "${spec_id}". Read the body, the contract, the architecture rules that apply and the current compliance.`,
          `2. Call check_dependencies. If a dependency isn't satisfied, stop and tell the developer.`,
          `3. Call set_spec_status with status "in-progress" unless the spec already is.`,
          `4. Write the code. After each change call check_compliance with spec_id "${spec_id}" and fix everything it reports, until done is true.`,
          `5. Call set_spec_status with status "implemented".`,
          "",
          "Never weaken a contract in the spec to make a check pass. update_spec_bindings only proposes contract edits: show the proposal to the developer and let them decide.",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "fix-drift",
    {
      description: "Bring a spec and its code back in line after the code changed",
      argsSchema: promptArgs,
    },
    async ({ spec_id }) => {
      findSpec(await ws.model(), spec_id);
      return user(
        [
          `The code of the CatSpec spec "${spec_id}" no longer matches it. Fix that.`,
          "",
          `1. Call check_compliance with spec_id "${spec_id}" and read each diagnostic.`,
          "2. Renamed or moved code (CS0201 not found, CS0210 renamed): call sync_specs as a dry run, check the mapping, then call it again with dry_run false.",
          `3. Signature drift (CS0300) that was intended: ask the developer to run \`catspec accept ${spec_id}\`.`,
          "4. Anything else: change the code until check_compliance says done is true.",
          "",
          "Never weaken a contract in the spec to make a check pass; ask the developer instead.",
        ].join("\n"),
      );
    },
  );

  return server;
}

/** Serves the repository over stdio until the client disconnects. */
export async function serveMcp(options: WorkspaceOptions): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  const handle: StdioServerHandle = serveStdio(() => createServer(options), {
    onerror: (error) => process.stderr.write(`catspec mcp: ${error.message}\n`),
  });
  await closed;
  await handle.close();
  await options.engine.close();
}
