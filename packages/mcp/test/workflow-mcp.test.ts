/**
 * Feature F8 `workflow-profiles`, PBI `workflow-mcp`: `next_step`, `start_stage`, `finish_stage`,
 * the `workflow` block of `get_spec_context` and the `stage-<id>` prompts, against the CLI.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { cliEngine, run } from "@catspec/cli";
import { customWorkflowYaml } from "@catspec/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { ADR_LOG, adrLogText, createRepo, specText } from "../../../test/temp-repo.js";
import { createServer } from "../src/index.js";

const FEATURE = "docs/spec/user-account-management";

const files = {
  [ADR_LOG]: adrLogText(),
  "catspec.yaml": customWorkflowYaml(),
  [`${FEATURE}/spec.md`]: "# Accounts\n",
  [`${FEATURE}/plan.md`]: "# Plan\n",
  [`${FEATURE}/register-api.spec.md`]: specText("register-api", {
    status: "ready",
    extra: "bindings:\n  - symbol: register\n    kind: function\n",
    body: "# Register\n\n## Tasks\n\n- [x] register()\n",
  }),
  [`${FEATURE}/email-verification.spec.md`]: specText("email-verification", {
    status: "ready",
    dependsOn: ["register-api"],
    extra: "bindings:\n  - symbol: verify\n    kind: function\n",
  }),
  "src/auth.ts": "export function register(): void {}\n",
};

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function withServer(fn: (dir: string, client: Client) => Promise<void>): Promise<void> {
  const repo = await createRepo(files, { git: true });
  const engine = cliEngine();
  const server = createServer({ root: repo.dir, engine });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "scripted-agent", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    await fn(repo.dir, client);
  } finally {
    await client.close();
    await server.close();
    await engine.close();
    await repo.cleanup();
  }
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

async function cliJson(dir: string, args: string[]): Promise<Record<string, unknown>> {
  let stdout = "";
  const code = await run([...args, "--format", "json"], {
    cwd: dir,
    env: {},
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: () => true },
    stdin: () => Promise.resolve(""),
  });
  expect(code).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("F8 workflow-profiles: PBI workflow-mcp", () => {
  it("[AC-workflow-mcp-1] next_step over MCP and catspec next name the same stage, driver and gates", async () => {
    await withServer(async (dir, client) => {
      const mcp = await call(client, "next_step", { feature: "user-account-management" });
      expect(mcp.isError).toBeFalsy();
      const cli = await cliJson(dir, ["next", "user-account-management"]);
      expect(mcp.structuredContent).toEqual(cli);
      expect(cli).toMatchObject({
        stage: { id: "task", driverText: "skill sdd-task", finish: { gates: ["contracts_pass"] } },
      });
      expect(mcp.content[0]!.text).toContain(
        "ready: register-api → stage task, use skill sdd-task",
      );
    });
  });

  it("start_stage and finish_stage run the gates and set the status like the CLI; get_spec_context has a workflow block", async () => {
    await withServer(async (dir, client) => {
      const context = await call(client, "get_spec_context", { spec_id: "register-api" });
      expect(context.structuredContent?.workflow).toEqual({
        feature: "user-account-management",
        done: false,
        stage: "task",
        per: "spec",
        driver: "skill sdd-task",
        start_gates: ["deps_ready"],
        finish_gates: ["contracts_pass"],
      });

      const early = await call(client, "start_stage", {
        feature: "email-verification",
        stage: "task",
      });
      expect(early.structuredContent).toMatchObject({ ok: false });
      expect(early.content[0]!.text).toContain("CS0701");

      const started = await call(client, "start_stage", { feature: "register-api" });
      expect(started.structuredContent).toMatchObject({
        ok: true,
        stage: { id: "task" },
        changes: [{ spec: "register-api", from: "ready", to: "in-progress" }],
      });
      const finished = await call(client, "finish_stage", {
        feature: "register-api",
        stage: "close",
      });
      expect(finished.structuredContent).toMatchObject({ ok: true });
      expect(await readFile(join(dir, FEATURE, "register-api.spec.md"), "utf8")).toContain(
        "status: implemented",
      );

      const unknown = await call(client, "start_stage", { feature: "nope" });
      expect(unknown.isError).toBe(true);
    });
  });

  it("get_spec_context still serves the architecture spec, without a workflow block; start_stage has no force", async () => {
    await withServer(async (_dir, client) => {
      const context = await call(client, "get_spec_context", { spec_id: "architecture" });
      expect(context.isError).toBeFalsy();
      expect(context.structuredContent?.id).toBe("architecture");
      expect(context.structuredContent).not.toHaveProperty("workflow");
      const { tools } = await client.listTools();
      const start = tools.find((t) => t.name === "start_stage")!;
      expect(Object.keys(start.inputSchema.properties ?? {})).toEqual(["feature", "stage"]);
      expect(start.annotations?.idempotentHint).toBe(false);
    });
  });

  it("serves one stage-<id> prompt per workflow stage", async () => {
    await withServer(async (_dir, client) => {
      const prompt = await client.getPrompt({
        name: "stage-plan",
        arguments: { target: "user-account-management" },
      });
      const text = (prompt.messages[0]!.content as { text: string }).text;
      expect(text).toContain('start_stage with feature "user-account-management" and stage "plan"');
      expect(text).toContain("skill sdd-plan");
      expect(text).toContain("{feature_dir}/plan.md");
    });
  });
});
