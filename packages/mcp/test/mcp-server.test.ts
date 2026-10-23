/**
 * Feature F7 `mcp-server-and-agent-layer`, the MCP side (PBIs `mcp-server-core`, `mcp-tools`,
 * `mcp-resources-and-prompts`): a scripted agent talks to the server through the in-process MCP
 * client, on temporary repositories. The engine is the one `catspec mcp` runs on.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cliEngine } from "@catspec/cli";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

import { ADR_LOG, adrLogText, createRepo, specText } from "../../../test/temp-repo.js";
import { createServer, type Engine } from "../src/index.js";

const SPEC_FILE = "docs/spec/auth/login.spec.md";
const CODE_FILE = "src/auth.ts";

/** The spec `login`: class `AuthService` with a method `login`. */
const loginSpec = (status = "in-progress", members = ["login"]): string =>
  specText("login", {
    status,
    extra:
      "bindings:\n  - id: auth\n    symbol: AuthService\n    kind: class\n    members:\n" +
      members.map((m) => `      - name: ${m}\n        kind: method\n`).join(""),
    body: "# Login\n\nUsers sign in with `AuthService`.\n",
  });

const authService = (method: string): string =>
  `export class AuthService {\n  ${method}(user: string, password: string): boolean {\n    return user.length > 0 && password.length > 0;\n  }\n}\n`;

interface Connection {
  client: Client;
  /** Calls to the engine's `loadCodebase` so far (each reads the repository's files). */
  reads: () => number;
  close: () => Promise<void>;
}

async function connect(root: string): Promise<Connection> {
  const engine = cliEngine();
  let reads = 0;
  const counting: Engine = {
    ...engine,
    loadCodebase: (...args) => {
      reads++;
      return engine.loadCodebase(...args);
    },
    loadStaged: (...args) => {
      reads++;
      return engine.loadStaged(...args);
    },
  };
  const server = createServer({ root, engine: counting });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "scripted-agent", version: "0.0.0" });
  await client.connect(clientSide);
  return {
    client,
    reads: () => reads,
    close: async () => {
      await client.close();
      await server.close();
      await engine.close();
    },
  };
}

/** A repository with the spec `login` and `AuthService` declaring `method`. */
async function withAuthRepo(
  fn: (repo: { dir: string; mcp: Connection }) => Promise<void>,
  options: { method?: string; spec?: string; config?: string } = {},
): Promise<void> {
  const repo = await createRepo(
    {
      [ADR_LOG]: adrLogText(),
      [SPEC_FILE]: options.spec ?? loginSpec(),
      [CODE_FILE]: authService(options.method ?? "signIn"),
      ...(options.config ? { "catspec.yaml": options.config } : {}),
    },
    { git: true },
  );
  const mcp = await connect(repo.dir);
  try {
    await fn({ dir: repo.dir, mcp });
  } finally {
    await mcp.close();
    await repo.cleanup();
  }
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(
  mcp: Connection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await mcp.client.callTool({ name, arguments: args })) as ToolResult;
}

/** The text for the model (the second item is the same facts as JSON). */
const text = (result: ToolResult): string => result.content[0]?.text ?? "";

interface DiagnosticJson {
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

describe("F7 mcp-server-and-agent-layer: the MCP server", () => {
  it("[AC-F7-1] the agent fixes its own mistake: CS0203 expected login found signIn, then done and implemented (spec AC-9)", async () => {
    await withAuthRepo(async ({ dir, mcp }) => {
      const first = await call(mcp, "check_compliance", { spec_id: "login" });
      expect(first.isError).toBeFalsy();
      expect(first.structuredContent?.done).toBe(false);
      const missing = (first.structuredContent?.diagnostics as DiagnosticJson[]).find(
        (d) => d.code === "CS0203",
      );
      expect(missing).toMatchObject({
        expected: "method login",
        actual: ["method signIn(user: string, password: string): boolean"],
      });
      expect(text(first)).toMatch(/CS0203 member login missing in AuthService/);
      expect(text(first)).toMatch(/expected: method login\n +found: +method signIn\(/);
      expect(text(first)).toMatch(/fix: +did you mean signIn\?/);

      await writeFile(join(dir, CODE_FILE), authService("login"), "utf8");
      const second = await call(mcp, "check_compliance", { spec_id: "login" });
      expect(second.structuredContent?.done).toBe(true);
      expect(text(second)).toMatch(/DONE$/);

      const status = await call(mcp, "set_spec_status", {
        spec_id: "login",
        status: "implemented",
      });
      expect(status.structuredContent).toMatchObject({ changed: true, refused: false });
      expect(await readFile(join(dir, SPEC_FILE), "utf8")).toMatch(/^status: implemented$/m);
    });
  });

  it("[AC-F7-2] the agent can't weaken a contract: removing a member returns a proposal and the spec is unchanged (spec AC-10)", async () => {
    await withAuthRepo(async ({ dir, mcp }) => {
      const before = await readFile(join(dir, SPEC_FILE), "utf8");
      const result = await call(mcp, "update_spec_bindings", {
        spec_id: "login",
        patch: { auth: { members: [] } },
        dry_run: false,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        class: "contract",
        proposal: true,
        applied: false,
      });
      expect(result.structuredContent?.diff).toMatch(/^-\s+- name: login$/m);
      expect(text(result)).toMatch(/proposal only/);
      expect(await readFile(join(dir, SPEC_FILE), "utf8")).toBe(before);
    });
  });

  describe("PBI mcp-server-core", () => {
    it("[AC-mcp-server-core-1] a path outside the repository is refused and nothing is read", async () => {
      await withAuthRepo(async ({ mcp }) => {
        for (const tool of ["check_compliance", "find_specs_for_file"]) {
          const result = await call(mcp, tool, { file_path: "../../etc/passwd" });
          expect(result.isError).toBe(true);
          expect(text(result)).toMatch(/outside the repository/);
        }
        const absolute = await call(mcp, "find_specs_for_file", {
          file_path: resolve("/", "etc", "passwd"),
        });
        expect(absolute.isError).toBe(true);
        expect(mcp.reads()).toBe(0);
      });
    });

    it("[AC-mcp-server-core-2] an edited spec is picked up by the next call", async () => {
      await withAuthRepo(async ({ dir, mcp }) => {
        const first = await call(mcp, "get_spec_context", { spec_id: "login" });
        expect(first.structuredContent?.body).toMatch(/Users sign in/);
        await writeFile(
          join(dir, SPEC_FILE),
          loginSpec("in-progress", ["login", "logout"]).replace("Users sign in", "Users log in"),
          "utf8",
        );
        const second = await call(mcp, "get_spec_context", { spec_id: "login" });
        expect(second.structuredContent?.body).toMatch(/Users log in/);
        const contract = second.structuredContent?.contract as {
          bindings: { members: { name: string }[] }[];
        };
        expect(contract.bindings[0]!.members.map((m) => m.name)).toEqual(["login", "logout"]);
      });
    });

    it("serves every tool of plan §D14.1", async () => {
      await withAuthRepo(async ({ mcp }) => {
        const { tools } = await mcp.client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          "check_compliance",
          "check_dependencies",
          "find_specs_for_file",
          "finish_stage",
          "get_spec_context",
          "list_specs",
          "next_step",
          "set_spec_status",
          "start_refactor",
          "start_stage",
          "sync_specs",
          "update_spec_bindings",
        ]);
      });
    });

    it("`catspec mcp` serves the tools over stdio", async () => {
      const repo = await createRepo(
        { [ADR_LOG]: adrLogText(), [SPEC_FILE]: loginSpec(), [CODE_FILE]: authService("login") },
        { git: true },
      );
      const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
      const client = new Client({ name: "stdio-agent", version: "0.0.0" });
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              "--conditions=source",
              "--import",
              pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
              join(repoRoot, "packages", "cli", "src", "bin.ts"),
              "mcp",
            ],
            cwd: repo.dir,
            stderr: "pipe",
          }),
        );
        const result = (await client.callTool({
          name: "check_compliance",
          arguments: { spec_id: "login" },
        })) as ToolResult;
        expect(result.structuredContent?.done).toBe(true);
      } finally {
        await client.close();
        await repo.cleanup();
      }
    }, 60_000);
  });

  describe("PBI mcp-tools", () => {
    it("[AC-mcp-tools-1] the agent loop: get_spec_context, check_compliance, fix, check_compliance is done (spec AC-9)", async () => {
      await withAuthRepo(async ({ dir, mcp }) => {
        const context = await call(mcp, "get_spec_context", { spec_id: "login" });
        expect(context.structuredContent).toMatchObject({
          id: "login",
          status: "in-progress",
          files: { auth: [CODE_FILE] },
          compliance: { done: false },
        });
        const failing = await call(mcp, "check_compliance", { spec_id: "login" });
        expect(failing.structuredContent?.done).toBe(false);
        await writeFile(join(dir, CODE_FILE), authService("login"), "utf8");
        const passing = await call(mcp, "check_compliance", { file_path: CODE_FILE });
        expect(passing.structuredContent).toMatchObject({ done: true, specs: ["login"] });
      });
    });

    it("[AC-mcp-tools-2] contract edits are only proposed, even with dry_run false (spec AC-10)", async () => {
      await withAuthRepo(async ({ dir, mcp }) => {
        const before = await readFile(join(dir, SPEC_FILE), "utf8");
        const result = await call(mcp, "update_spec_bindings", {
          spec_id: "login",
          patch: { auth: { members: null } },
          dry_run: false,
        });
        expect(result.structuredContent).toMatchObject({ proposal: true, applied: false });
        expect(String(result.structuredContent?.diff)).toMatch(/^-\s+members:$/m);
        expect(await readFile(join(dir, SPEC_FILE), "utf8")).toBe(before);
      });
    });

    it("[AC-mcp-tools-3] implemented is refused while a contract fails, and the failing contract is listed", async () => {
      await withAuthRepo(async ({ dir, mcp }) => {
        const before = await readFile(join(dir, SPEC_FILE), "utf8");
        const result = await call(mcp, "set_spec_status", {
          spec_id: "login",
          status: "implemented",
        });
        expect(result.structuredContent).toMatchObject({ changed: false, refused: true });
        const codes = (result.structuredContent?.diagnostics as DiagnosticJson[]).map(
          (d) => d.code,
        );
        expect(codes).toContain("CS0203");
        expect(text(result)).toMatch(/refused: login stays in-progress/);
        expect(await readFile(join(dir, SPEC_FILE), "utf8")).toBe(before);
      });
    });

    it("location edits are applied when allowed, and only after a dry run says what they do", async () => {
      await withAuthRepo(
        async ({ dir, mcp }) => {
          const patch = { auth: { symbol: "AuthService", file: CODE_FILE } };
          const dry = await call(mcp, "update_spec_bindings", { spec_id: "login", patch });
          expect(dry.structuredContent).toMatchObject({ class: "location", applied: false });
          const applied = await call(mcp, "update_spec_bindings", {
            spec_id: "login",
            patch,
            dry_run: false,
          });
          expect(applied.structuredContent).toMatchObject({ class: "location", applied: true });
          expect(await readFile(join(dir, SPEC_FILE), "utf8")).toMatch(
            /^ {4}file: src\/auth\.ts$/m,
          );
        },
        { method: "login" },
      );
    });

    it("contract edits are applied when mcp.allow_contract_edits is true", async () => {
      await withAuthRepo(
        async ({ dir, mcp }) => {
          const result = await call(mcp, "update_spec_bindings", {
            spec_id: "login",
            patch: { auth: { members: [{ name: "signIn", kind: "method" }] } },
            dry_run: false,
          });
          expect(result.structuredContent).toMatchObject({ class: "contract", applied: true });
          expect(await readFile(join(dir, SPEC_FILE), "utf8")).toMatch(/- name: signIn/);
          const check = await call(mcp, "check_compliance", { spec_id: "login" });
          expect(check.structuredContent?.done).toBe(true);
        },
        { config: "version: 1\nmcp:\n  allow_contract_edits: true\n" },
      );
    });

    it("list_specs, find_specs_for_file and check_dependencies describe the specs", async () => {
      const dependent = specText("session", { status: "ready", dependsOn: ["login"] });
      await withAuthRepo(async ({ dir, mcp }) => {
        await writeFile(join(dir, "docs/spec/auth/session.spec.md"), dependent, "utf8");
        const list = await call(mcp, "list_specs", {});
        const rows = list.structuredContent?.specs as { id: string; deps_satisfied: boolean }[];
        expect(rows.map((r) => [r.id, r.deps_satisfied])).toEqual([
          ["architecture", true],
          ["login", true],
          ["session", false],
        ]);
        const forFile = await call(mcp, "find_specs_for_file", { file_path: CODE_FILE });
        expect(forFile.structuredContent?.specs).toMatchObject([
          { id: "login", via: ["binding:auth"] },
        ]);
        const deps = await call(mcp, "check_dependencies", { spec_id: "session" });
        expect(deps.structuredContent).toMatchObject({
          satisfied: false,
          dependencies: [{ id: "login", status: "in-progress", satisfied: false }],
        });
        const unknown = await call(mcp, "get_spec_context", { spec_id: "logon" });
        expect(unknown.isError).toBe(true);
        expect(text(unknown)).toMatch(/did you mean "login"/);
      });
    });
  });

  describe("tool details", () => {
    it("a status that lowers enforcement, or any change to the architecture spec, is refused", async () => {
      await withAuthRepo(
        async ({ dir, mcp }) => {
          const before = await readFile(join(dir, SPEC_FILE), "utf8");
          for (const status of ["ready", "draft", "deprecated"]) {
            const result = await call(mcp, "set_spec_status", { spec_id: "login", status });
            expect(result.structuredContent, status).toMatchObject({
              changed: false,
              refused: true,
              proposal: true,
            });
            expect(text(result)).toMatch(/lowers what is enforced; that is the developer's call/);
          }
          const architecture = await call(mcp, "set_spec_status", {
            spec_id: "architecture",
            status: "implemented",
          });
          expect(architecture.structuredContent).toMatchObject({ refused: true });
          expect(text(architecture)).toMatch(/is the architecture spec/);
          expect(await readFile(join(dir, SPEC_FILE), "utf8")).toBe(before);
        },
        { method: "login", spec: loginSpec("implemented") },
      );
    });

    it("empty links are refused before anything is written", async () => {
      await withAuthRepo(
        async ({ dir, mcp }) => {
          const before = await readFile(join(dir, SPEC_FILE), "utf8");
          const result = await call(mcp, "set_spec_status", {
            spec_id: "login",
            status: "in-progress",
            links: { pr: "" },
          });
          expect(result.isError).toBe(true);
          expect(await readFile(join(dir, SPEC_FILE), "utf8")).toBe(before);
          const linked = await call(mcp, "set_spec_status", {
            spec_id: "login",
            status: "in-progress",
            links: { pr: 17 },
          });
          expect(linked.structuredContent).toMatchObject({ changed: true });
          expect(await readFile(join(dir, SPEC_FILE), "utf8")).toMatch(/^ {2}pr: 17$/m);
        },
        { method: "login" },
      );
    });

    it("check_compliance with staged reads the specs and the code from the git index", async () => {
      await withAuthRepo(
        async ({ dir, mcp }) => {
          execFileSync("git", ["add", "-A"], { cwd: dir });
          // The working tree renames the member to match the code; the index still requires login.
          await writeFile(join(dir, SPEC_FILE), loginSpec("in-progress", ["signIn"]), "utf8");
          const working = await call(mcp, "check_compliance", { spec_id: "login" });
          expect(working.structuredContent?.done).toBe(true);
          const staged = await call(mcp, "check_compliance", { spec_id: "login", staged: true });
          expect(staged.structuredContent?.done).toBe(false);
          expect(text(staged)).toMatch(/CS0203 member login missing/);
        },
        { method: "signIn" },
      );
    });

    it("check_compliance for a file checks only its in-progress and implemented specs", async () => {
      await withAuthRepo(
        async ({ mcp }) => {
          const draft = await call(mcp, "check_compliance", { file_path: CODE_FILE });
          expect(draft.structuredContent).toMatchObject({ done: true, specs: [] });
          expect(text(draft)).toMatch(/no in-progress or implemented spec binds src\/auth\.ts/);
        },
        { spec: loginSpec("draft") },
      );
    });

    it("get_spec_context lists the architecture rules for the spec's files, import rules by `from`", async () => {
      const rules = `rules:
  - id: domain-no-infrastructure
    adr: ADR-001
    class: structural
    forbid_import:
      from: "src/**"
      to: ["infra/**"]
  - id: infra-no-domain
    adr: ADR-001
    class: structural
    forbid_import:
      from: "infra/**"
      to: ["src/**"]
  - id: only-in-lib
    adr: ADR-001
    class: structural
    paths: ["lib/**"]
    forbid_call: eval
`;
      await withAuthRepo(async ({ dir, mcp }) => {
        await writeFile(join(dir, ADR_LOG), adrLogText(["ADR-001"], rules), "utf8");
        const context = await call(mcp, "get_spec_context", { spec_id: "login" });
        const ids = (context.structuredContent?.architecture_rules as { id: string }[]).map(
          (r) => r.id,
        );
        expect(ids).toEqual(["domain-no-infrastructure"]);
      });
    });

    it("every tool result also carries its facts as JSON text", async () => {
      await withAuthRepo(async ({ mcp }) => {
        const result = await call(mcp, "list_specs", {});
        expect(result.content).toHaveLength(2);
        expect(JSON.parse(result.content[1]!.text!)).toEqual(result.structuredContent);
      });
    });
  });

  describe("PBI mcp-resources-and-prompts", () => {
    it("[AC-mcp-resources-and-prompts-1] resources are listed and readable: the raw spec and a mermaid graph", async () => {
      await withAuthRepo(async ({ dir, mcp }) => {
        const { resources } = await mcp.client.listResources();
        const uris = resources.map((r) => r.uri);
        expect(uris).toEqual(
          expect.arrayContaining([
            "catspec://spec/login",
            "catspec://architecture",
            "catspec://graph",
            "catspec://diagnostics",
          ]),
        );
        const spec = await mcp.client.readResource({ uri: "catspec://spec/login" });
        expect(spec.contents[0]).toMatchObject({
          text: await readFile(join(dir, SPEC_FILE), "utf8"),
        });
        const graph = await mcp.client.readResource({ uri: "catspec://graph" });
        expect((graph.contents[0] as { text: string }).text).toMatch(/^graph LR\n/);
        const architecture = await mcp.client.readResource({ uri: "catspec://architecture" });
        expect((architecture.contents[0] as { text: string }).text).toBe(adrLogText());

        await call(mcp, "check_compliance", { spec_id: "login" });
        const last = await mcp.client.readResource({ uri: "catspec://diagnostics" });
        expect(JSON.parse((last.contents[0] as { text: string }).text)).toMatchObject({
          specs: ["login"],
          done: false,
        });
      });
    });

    it("the prompts implement-spec and fix-drift name the spec and the tools to call", async () => {
      await withAuthRepo(async ({ mcp }) => {
        const { prompts } = await mcp.client.listPrompts();
        expect(prompts.map((p) => p.name).sort()).toEqual([
          "fix-drift",
          "implement-spec",
          "stage-close",
          "stage-plan",
          "stage-spec",
          "stage-task",
        ]);
        const implement = await mcp.client.getPrompt({
          name: "implement-spec",
          arguments: { spec_id: "login" },
        });
        const body = (implement.messages[0]!.content as { text: string }).text;
        expect(body).toMatch(/get_spec_context/);
        expect(body).toMatch(/check_compliance with spec_id "login"/);
        expect(body).toMatch(/Never weaken a contract/);
        const drift = await mcp.client.getPrompt({
          name: "fix-drift",
          arguments: { spec_id: "login" },
        });
        expect((drift.messages[0]!.content as { text: string }).text).toMatch(/sync_specs/);
      });
    });
  });
});
