/**
 * Feature F7 `mcp-server-and-agent-layer`, PBI `claude-code-validation`: a recorded Claude Code
 * session on the AuthService example (`examples/ts-auth-service/transcripts/`). The developer only
 * asked for the spec to be implemented; the agent ran the workflow through the MCP server by
 * itself, and the code it wrote still passes the spec.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { run } from "../packages/cli/src/index.js";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const EXAMPLE = join(root, "examples", "ts-auth-service");
const SPEC = "user-auth-service";

type Entry =
  | { kind: "setup"; fixture: string; command: string }
  | { kind: "prompt" | "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; is_error: boolean; content: string }
  | { kind: "hook"; event: string; exit_code: number; output: string }
  | { kind: "result"; turns: number; text: string };

interface StageResult {
  phase: "start" | "finish";
  ok: boolean;
  forced: boolean;
  gates: { gate: string; passed: boolean }[];
  changes: { spec: string; from: string; to: string }[];
}

const transcript: Entry[] = readFileSync(
  join(EXAMPLE, "transcripts", "claude-code-session.jsonl"),
  "utf8",
)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Entry);

const calls = transcript.flatMap((entry, index) =>
  entry.kind === "tool_use" ? [{ ...entry, index }] : [],
);
const resultOf = (id: string): string => {
  const result = transcript.find((e) => e.kind === "tool_result" && e.id === id);
  if (result?.kind !== "tool_result") throw new Error(`no result for ${id}`);
  return result.content;
};
/** The MCP calls of one tool, with their parsed results. */
const mcp = <T>(tool: string) =>
  calls
    .filter((c) => c.name === `mcp__catspec__${tool}`)
    .map((c) => ({ ...c, result: JSON.parse(resultOf(c.id)) as T }));

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("F7 mcp-server-and-agent-layer: recorded Claude Code session (PBI claude-code-validation)", () => {
  it("[AC-F7-4] a real Claude Code session takes the AuthService spec to implemented without a human typing a catspec command", async () => {
    // The developer wrote one message, and it names no catspec command.
    const prompts = transcript.filter((e) => e.kind === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.kind === "prompt" && prompts[0]!.text).not.toMatch(/catspec\s/);
    expect(transcript[0]!.kind === "setup" && transcript[0]!.fixture).toMatch(/init --agents/);

    // The status went ready → in-progress → implemented through the agent's own calls.
    const changes = [...mcp<StageResult>("start_stage"), ...mcp<StageResult>("finish_stage")]
      .sort((a, b) => a.index - b.index)
      .flatMap((c) => c.result.changes.filter((change) => change.spec === SPEC));
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      ["ready", "in-progress"],
      ["in-progress", "implemented"],
    ]);
    const final = transcript.at(-1)!;
    expect(final.kind === "result" && final.text).toMatch(/implemented/);

    // The code the agent wrote passes the spec on a copy of the example.
    const write = calls.find(
      (c) => c.name === "Write" && c.input.file_path === "src/services/AuthService.ts",
    );
    expect(write, "the agent wrote AuthService.ts").toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "catspec-claude-session-"));
    temps.push(dir);
    cpSync(EXAMPLE, dir, { recursive: true });
    writeFileSync(join(dir, "src/services/AuthService.ts"), write!.input.content as string);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    let output = "";
    const out = {
      write: (text: string): boolean => {
        output += text;
        return true;
      },
    };
    const code = await run(["check", "--spec", SPEC], { cwd: dir, stdout: out, stderr: out });
    expect(code, output).toBe(0);
    expect(output).toMatch(/DONE/);
  });

  it("[AC-claude-code-validation-1] the transcript shows the agent running stage start, check and stage finish by itself, and the spec ends implemented", () => {
    const start = mcp<StageResult>("start_stage");
    const checks = mcp<{ done: boolean }>("check_compliance");
    const finish = mcp<StageResult>("finish_stage");
    const firstWrite = calls.find((c) => c.name === "Write" || c.name === "Edit")!;

    // stage start task before any code, passing its gate, never forced.
    expect(start.map((c) => [c.input.stage, c.result.ok, c.result.forced])).toEqual([
      ["task", true, false],
    ]);
    expect(start[0]!.index).toBeLessThan(firstWrite.index);

    // The check failed before the code existed, then said DONE.
    expect(checks.map((c) => c.result.done)).toEqual([false, true]);
    expect(checks[1]!.index).toBeLessThan(finish[0]!.index);

    // stage finish task, then close: every gate passed, nothing forced, the spec implemented.
    expect(finish.map((c) => [c.input.stage, c.result.ok, c.result.forced])).toEqual([
      ["task", true, false],
      ["close", true, false],
    ]);
    expect(finish[1]!.result.gates.every((g) => g.passed)).toBe(true);
    expect(finish[1]!.result.changes).toContainEqual(
      expect.objectContaining({ spec: SPEC, to: "implemented" }),
    );

    // The Stop hook ran at the end and let the agent finish.
    const hooks = transcript.filter((e) => e.kind === "hook");
    expect(hooks.map((h) => h.kind === "hook" && [h.event, h.exit_code])).toEqual([["Stop", 0]]);
  });
});
