/**
 * Feature F7 `mcp-server-and-agent-layer`, the CLI side (PBIs `agent-check-mode` and
 * `agent-setup`): `catspec check --in-progress --format agent` as the Claude Code `Stop` hook, with
 * loop protection, and `catspec init --agents`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ADR_LOG, adrLogText, createRepo, specText } from "../../../test/temp-repo.js";
import { agentsBlock, BLOCK_BEGIN, BLOCK_END, STOP_HOOK_COMMAND } from "../src/agents-setup.js";
import { run } from "../src/index.js";

const SPEC_FILE = "docs/spec/api/register-api.spec.md";
const CODE_FILE = "src/auth.ts";

/** The spec `register-api`: class `AuthService` with the methods `register` and `login`. */
const registerApi = (status: string): string =>
  specText("register-api", {
    status,
    extra:
      "bindings:\n  - id: auth\n    symbol: AuthService\n    kind: class\n    members:\n" +
      "      - name: register\n        kind: method\n      - name: login\n        kind: method\n",
    body: "# Register API\n",
  });

const authService = (methods: string[]): string =>
  `export class AuthService {\n${methods.map((m) => `  ${m}(): void {}\n`).join("")}}\n`;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function catspec(cwd: string, args: string[], stdin = ""): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    cwd,
    env: {},
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    stdin: () => Promise.resolve(stdin),
  });
  return { code, stdout, stderr };
}

const AGENT_CHECK = ["check", "--in-progress", "--format", "agent"];
/** What Claude Code writes on the hook's stdin (only `session_id` is used). */
const hookInput = (session: string): string =>
  JSON.stringify({ session_id: session, hook_event_name: "Stop", stop_hook_active: false });

async function withRepo(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const repo = await createRepo({ [ADR_LOG]: adrLogText(), ...files }, { git: true });
  try {
    await fn(repo.dir);
  } finally {
    await repo.cleanup();
  }
}

const read = (dir: string, file: string): Promise<string> => readFile(join(dir, file), "utf8");

/** The hook command's arguments after `npx catspec`, as Claude Code's shell expands them. */
const hookArgs = (command: string, projectDir: string): string[] =>
  command
    .split(" ")
    .slice(2)
    .map((arg) => (arg === '"$CLAUDE_PROJECT_DIR"' ? projectDir : arg));

describe("F7 mcp-server-and-agent-layer: the agent layer", () => {
  it("[AC-F7-3] the agent can't stop early: the Stop hook exits 2 with the fix list, and after 3 identical failures the agent is let go and the user is told (spec AC-17)", async () => {
    await withRepo(
      { [SPEC_FILE]: registerApi("in-progress"), [CODE_FILE]: authService(["register"]) },
      async (dir) => {
        expect((await catspec(dir, ["init", "--agents"])).code).toBe(0);
        const settings = JSON.parse(await read(dir, ".claude/settings.json")) as {
          hooks: { Stop: { hooks: { command: string }[] }[] };
        };
        const command = settings.hooks.Stop[0]!.hooks[0]!.command;
        expect(command).toBe(
          'npx catspec --cwd "$CLAUDE_PROJECT_DIR" check --in-progress --format agent',
        );
        const args = hookArgs(command, dir);

        for (let attempt = 1; attempt <= 3; attempt++) {
          const blocked = await catspec(dir, args, hookInput("session-1"));
          expect(blocked.code, `attempt ${attempt}`).toBe(2);
          expect(blocked.stderr).toMatch(/register-api\) is NOT DONE/);
          expect(blocked.stderr).toMatch(/CS0203 member login missing in AuthService/);
          expect(blocked.stderr).toMatch(/Never weaken a contract/);
        }
        const released = await catspec(dir, args, hookInput("session-1"));
        expect(released.code).toBe(0);
        const message = (JSON.parse(released.stdout) as { systemMessage: string }).systemMessage;
        expect(message).toMatch(/register-api is stuck: the agent was blocked 3 times in a row/);
        expect(await read(dir, SPEC_FILE)).toMatch(/^status: in-progress$/m);
      },
    );
  });

  describe("PBI agent-check-mode", () => {
    const cases: { situation: string; files: Record<string, string>; code: number }[] = [
      {
        situation: "no spec in progress",
        files: { [SPEC_FILE]: registerApi("ready"), [CODE_FILE]: authService([]) },
        code: 0,
      },
      {
        situation: "an in-progress spec with all checks OK",
        files: {
          [SPEC_FILE]: registerApi("in-progress"),
          [CODE_FILE]: authService(["register", "login"]),
        },
        code: 0,
      },
      {
        situation: "an in-progress spec with a failure",
        files: { [SPEC_FILE]: registerApi("in-progress"), [CODE_FILE]: authService(["register"]) },
        code: 2,
      },
      {
        situation: "an invalid catspec.yaml",
        files: {
          "catspec.yaml": "version: 1\nlayout: sideways\n",
          [SPEC_FILE]: registerApi("in-progress"),
        },
        code: 1,
      },
    ];
    for (const { situation, files, code } of cases) {
      it(`[AC-agent-check-mode-1] exit code ${code} for ${situation}`, async () => {
        await withRepo(files, async (dir) => {
          const result = await catspec(dir, AGENT_CHECK);
          expect(result.code, result.stderr).toBe(code);
          if (code === 0) expect(result.stdout).toMatch(/DONE|no spec is in progress/);
          if (code === 1) expect(result.stderr).toMatch(/layout/);
        });
      });
    }

    it("[AC-agent-check-mode-2] loop protection: the 4th stop with the same diagnostics exits 0 and says the item is stuck", async () => {
      await withRepo(
        { [SPEC_FILE]: registerApi("in-progress"), [CODE_FILE]: authService(["register"]) },
        async (dir) => {
          for (let i = 0; i < 3; i++) {
            expect((await catspec(dir, AGENT_CHECK, hookInput("a"))).code).toBe(2);
          }
          const fourth = await catspec(dir, AGENT_CHECK, hookInput("a"));
          expect(fourth.code).toBe(0);
          expect(fourth.stderr).toMatch(/register-api is stuck/);
          // The count starts again: the next stop is blocked.
          expect((await catspec(dir, AGENT_CHECK, hookInput("a"))).code).toBe(2);
        },
      );
    });

    it("loop protection counts per session, a change in the diagnostics resets it, and --max-blocks sets the limit", async () => {
      await withRepo(
        { [SPEC_FILE]: registerApi("in-progress"), [CODE_FILE]: authService([]) },
        async (dir) => {
          const check = (session: string) =>
            catspec(dir, [...AGENT_CHECK, "--max-blocks", "1"], hookInput(session));
          expect((await check("a")).code).toBe(2);
          expect((await check("b")).code).toBe(2);
          await writeFile(join(dir, CODE_FILE), authService(["register"]), "utf8");
          expect((await check("a")).code).toBe(2);
          expect((await check("a")).code).toBe(0);
          // Without hook input there is no session to count: always blocked.
          for (let i = 0; i < 3; i++) expect((await catspec(dir, AGENT_CHECK)).code).toBe(2);
          await writeFile(join(dir, CODE_FILE), authService(["register", "login"]), "utf8");
          const done = await check("b");
          expect(done.code).toBe(0);
          expect(done.stdout).toBe("CatSpec: DONE (register-api)\n");
        },
      );
    });

    it("check --in-progress without --format agent reports the in-progress specs like --spec", async () => {
      await withRepo(
        {
          [SPEC_FILE]: registerApi("in-progress"),
          "docs/spec/api/other.spec.md": specText("other", { status: "draft" }),
          [CODE_FILE]: authService(["register"]),
        },
        async (dir) => {
          const text = await catspec(dir, ["check", "--in-progress"]);
          expect(text.code).toBe(1);
          expect(text.stdout).toMatch(/^spec register-api/m);
          expect(text.stdout).not.toMatch(/spec other/);
          expect(text.stdout).toMatch(/NOT DONE\n$/);
          const usage = await catspec(dir, ["check", "--in-progress", "--spec", "other"]);
          expect(usage.code).toBe(2);
        },
      );
    });
  });

  describe("PBI agent-setup", () => {
    it("[AC-agent-setup-1] the team's AGENTS.md is kept byte for byte and the CatSpec block appears once", async () => {
      const own = "# Our rules\r\n\r\nUse tabs.\r\nNo force pushes.";
      await withRepo({ "AGENTS.md": own }, async (dir) => {
        expect((await catspec(dir, ["init", "--agents"])).code).toBe(0);
        const once = await read(dir, "AGENTS.md");
        expect((await catspec(dir, ["init", "--agents"])).code).toBe(0);
        const twice = await read(dir, "AGENTS.md");
        expect(twice).toBe(once);
        expect(twice.split(BLOCK_BEGIN)).toHaveLength(2);
        expect(twice.split(BLOCK_END)).toHaveLength(2);
        expect(twice.startsWith(own)).toBe(true);
        expect(twice.slice(own.length)).toBe(`\r\n\r\n${agentsBlock("\r\n")}\r\n`);
      });
    });

    it("an outdated CatSpec block is replaced and the text around it is kept", async () => {
      const before = "# Rules\n\nBefore.\n\n";
      const after = "\n\nAfter.\n";
      await withRepo(
        { "AGENTS.md": `${before}${BLOCK_BEGIN}\nold text\n${BLOCK_END}${after}` },
        async (dir) => {
          expect((await catspec(dir, ["init", "--agents"])).code).toBe(0);
          expect(await read(dir, "AGENTS.md")).toBe(`${before}${agentsBlock()}${after}`);
        },
      );
    });

    it("[AC-agent-setup-2] an existing PostToolUse hook is kept when the Stop hook is added", async () => {
      const settings = {
        permissions: { allow: ["Bash(npm test)"] },
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [{ type: "command", command: "npx prettier --write ." }],
            },
          ],
        },
      };
      await withRepo({ ".claude/settings.json": JSON.stringify(settings) }, async (dir) => {
        expect((await catspec(dir, ["init", "--agents"])).code).toBe(0);
        expect((await catspec(dir, ["init", "--agents"])).code).toBe(0);
        const merged = JSON.parse(await read(dir, ".claude/settings.json")) as typeof settings & {
          hooks: { Stop: unknown[] };
        };
        expect(merged.permissions).toEqual(settings.permissions);
        expect(merged.hooks.PostToolUse).toEqual(settings.hooks.PostToolUse);
        expect(merged.hooks.Stop).toEqual([
          { hooks: [{ type: "command", command: STOP_HOOK_COMMAND }] },
        ]);
      });
    });

    it("settings that aren't valid JSON are refused and nothing is written", async () => {
      await withRepo({ ".claude/settings.json": "{ hooks: " }, async (dir) => {
        const result = await catspec(dir, ["init", "--agents"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/\.claude\/settings\.json isn't valid JSON/);
        expect(await read(dir, ".claude/settings.json")).toBe("{ hooks: ");
        await expect(read(dir, "AGENTS.md")).rejects.toThrow();
      });
    });

    it.each([
      [
        { hooks: { Stop: [null] } },
        /"hooks\.Stop\[0\]" in \.claude\/settings\.json must be an object/,
      ],
      [{ hooks: { Stop: [{ hooks: "x" }] } }, /"hooks\.Stop\[0\]" .*\.hooks must be a list/],
      [
        { hooks: { Stop: [{ hooks: [{ command: 1 }] }] } },
        /\.hooks\[0\]\.command must be a string/,
      ],
    ])(
      "Stop hooks of an unexpected shape are refused and nothing is written (%j)",
      async (settings, error) => {
        const text = JSON.stringify(settings);
        await withRepo({ ".claude/settings.json": text }, async (dir) => {
          const result = await catspec(dir, ["init", "--agents"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toMatch(error);
          expect(await read(dir, ".claude/settings.json")).toBe(text);
        });
      },
    );

    it("[AC-agent-setup-3] with the installed Stop hook and an in-progress spec with a missing member, the stop is blocked with the fix list (spec AC-17)", async () => {
      await withRepo(
        { [SPEC_FILE]: registerApi("in-progress"), [CODE_FILE]: authService(["register"]) },
        async (dir) => {
          expect((await catspec(dir, ["init", "--agents"])).code).toBe(0);
          const settings = JSON.parse(await read(dir, ".claude/settings.json")) as {
            hooks: { Stop: { hooks: { command: string }[] }[] };
          };
          const args = hookArgs(settings.hooks.Stop[0]!.hooks[0]!.command, dir);
          // The agent's shell may have moved into a subfolder; `--cwd` still finds the project.
          const stop = await catspec(join(dir, "src"), args, hookInput("session"));
          expect(stop.code).toBe(2);
          expect(stop.stderr).toMatch(
            /✖ binding:auth\.login +CS0203 member login missing in AuthService/,
          );
          expect(stop.stderr).toMatch(/fix: +add login to AuthService, or update the spec/);
          expect(stop.stderr).toMatch(/NOT DONE\n$/);
        },
      );
    });
  });
});
