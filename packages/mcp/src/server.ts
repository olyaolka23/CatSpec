/**
 * The CatSpec MCP server (plan §D14), PBIs `mcp-server-core`, `mcp-tools` and
 * `mcp-resources-and-prompts`: `catspec mcp` serves it on stdio.
 *
 * - Tools (§D14.1): see `./tools.ts`.
 * - Resources (§D14.2): `catspec://spec/{id}` (the raw spec file), `catspec://architecture` (the
 *   ADR log), `catspec://graph` (mermaid) and `catspec://diagnostics` (the last check, as JSON).
 * - Prompts (§D14.2): `implement-spec` and `fix-drift`, and one `stage-<id>` prompt per workflow
 *   stage, generated from the config when the server starts (§D17.5).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  checkCode,
  defaultConfig,
  describeStage,
  findConfig,
  parseConfig,
  SPEC_STATUSES,
  workflowProfile,
  type CatspecConfig,
} from "@catspec/core";
import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

import {
  checkCompliance,
  checkDependencies,
  findSpec,
  findSpecsForFile,
  getSpecContext,
  listSpecs,
  nextStep,
  runStage,
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
  "CatSpec checks code against specs (docs/spec/<feature>/<id>.spec.md). next_step names the " +
  "current workflow stage of a feature and how to do it; start_stage and finish_stage run the " +
  "stage's gates. To implement a spec: get_spec_context, start_stage, write the code, then " +
  "check_compliance until done is true, then finish_stage. Never weaken a " +
  "contract to make a check pass: update_spec_bindings only proposes contract edits; show the " +
  "proposal to the developer.";

/**
 * A tool's answer as an MCP result: the text, and the same facts as structured content. The facts
 * are also sent as JSON text, for clients that pass only the content to the model.
 */
const result = (output: ToolOutput): CallToolResult => ({
  content: [
    { type: "text", text: output.text },
    { type: "text", text: JSON.stringify(output.data) },
  ],
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
        "Move a spec's status forward (draft, ready, in-progress, implemented) with the " +
        "lifecycle rules: in-progress and implemented need the dependencies implemented and " +
        "passing; implemented is refused while the spec's contracts fail. Lowering a status, " +
        "deprecating a spec and changing the architecture spec are refused: the developer " +
        "does that. Optional links (pr, issue, commit) are recorded in the spec.",
      inputSchema: z.object({
        spec_id: specId,
        status,
        links: z
          .object({
            pr: z.union([z.string().min(1), z.number().int().positive()]).optional(),
            issue: z.union([z.string().min(1), z.number().int().positive()]).optional(),
            commit: z.string().min(1).optional(),
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

  const target = z.string().min(1).describe("a feature (folder name) or a spec id");

  server.registerTool(
    "next_step",
    {
      description:
        "What to do next for a feature or a work item: the current workflow stage, its driver " +
        "(skill, slash command, command), the files to read and to produce, its gates, and " +
        "which work items are ready or waiting. The same answer as `catspec next`.",
      inputSchema: z.object({ feature: target }),
      annotations: readOnly,
    },
    async (input) => result(await nextStep(ws, input)),
  );

  for (const phase of ["start", "finish"] as const) {
    server.registerTool(
      `${phase}_stage`,
      {
        description:
          `${phase === "start" ? "Start" : "Finish"} a workflow stage for a feature or a spec: ` +
          `runs the stage's ${phase} gates and, when they pass, sets the status the stage sets. ` +
          "Without stage, the current stage. Failing gates come back with their diagnostics; " +
          "fix them and call again. Like `catspec stage " +
          phase +
          "`.",
        inputSchema: z.object({
          feature: target,
          stage: z.string().min(1).optional().describe("the stage id (default: the current one)"),
          force: z
            .boolean()
            .optional()
            .describe("override failing gates (logged); only when the developer asks for it"),
        }),
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input) => result(await runStage(ws, phase, input)),
    );
  }

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

  // One prompt per workflow stage (plan §D17.5).
  const targetArgs = z.object({
    target: z.string().describe("a feature (folder name) or a spec id"),
  });
  for (const stage of workflowProfile(startupConfig(options)).stages) {
    const info = describeStage(stage);
    server.registerPrompt(
      `stage-${stage.id}`,
      {
        description: `Do the workflow stage "${stage.id}" (${info.driverText}) with its CatSpec gates`,
        argsSchema: targetArgs,
      },
      ({ target }) =>
        user(
          [
            `Do the workflow stage "${stage.id}" for "${target}".`,
            "",
            `1. Call start_stage with feature "${target}" and stage "${stage.id}". If it is refused, stop and tell the developer why.`,
            `2. Do the stage: ${info.driverText}.` +
              (stage.produces.length > 0 ? ` It must produce ${stage.produces.join(", ")}.` : ""),
            stage.per === "spec"
              ? `3. For each spec, call check_compliance with its spec_id after each change and fix everything it reports, until done is true.`
              : "3. Check your work against the finish gates listed by start_stage.",
            `4. Call finish_stage with feature "${target}" and stage "${stage.id}", and fix everything it reports until it passes.`,
            "",
            "Never weaken a contract in a spec to make a check pass; ask the developer instead.",
          ].join("\n"),
        ),
    );
  }

  return server;
}

/** The config when the server starts (for the stage prompts); the defaults if it can't be read. */
function startupConfig(options: WorkspaceOptions): CatspecConfig {
  try {
    const file = options.configFile ?? findConfig(options.root);
    return file ? parseConfig(readFileSync(file, "utf8")) : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

/** Serves the repository over stdio until the client disconnects or the connection fails. */
export async function serveMcp(options: WorkspaceOptions): Promise<void> {
  let ended!: () => void;
  const closed = new Promise<void>((resolve) => (ended = resolve));
  // Closed on stdin's end, on a broken stdout and on the server's own shutdown alike.
  class Transport extends StdioServerTransport {
    override async close(): Promise<void> {
      await super.close();
      ended();
    }
  }
  const handle: StdioServerHandle = serveStdio(() => createServer(options), {
    transport: new Transport(),
    onerror: (error) => process.stderr.write(`catspec mcp: ${error.message}\n`),
  });
  await closed;
  await handle.close();
  await options.engine.close();
}
