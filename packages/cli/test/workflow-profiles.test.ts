/**
 * Feature F8 `workflow-profiles` (PBIs `stage-resolution`, `gate-runner`, `workflow-cli`,
 * `workflow-presets`, `workflow-hook`): CatSpec gates the team's own SDD workflow (custom skills,
 * OpenSpec, Spec Kit) with `catspec next`, `catspec stage start|finish` and `catspec workflow`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import {
  customWorkflowYaml,
  loadConfig,
  loadSpecModel,
  runCommand,
  Workflow,
  workflowProfile,
  type CommandRunner,
  type NextStep,
  type StageRun,
} from "@catspec/core";
import { describe, expect, it, vi } from "vitest";

import { ADR_LOG, adrLogText, createRepo, specText, withRepo } from "../../../test/temp-repo.js";
import { loadCodebase } from "../src/codebase.js";
import { run } from "../src/index.js";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function catspec(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    cwd,
    env,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    stdin: () => Promise.resolve(""),
  });
  return { code, stdout, stderr };
}

const json = async <T>(cwd: string, args: string[]): Promise<T> => {
  const result = await catspec(cwd, [...args, "--format", "json"]);
  return JSON.parse(result.stdout) as T;
};

async function inRepo(
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
const statusOf = async (dir: string, file: string): Promise<string | undefined> =>
  /^status: (\S+)$/m.exec(await read(dir, file))?.[1];

const SKILLS = Object.fromEntries(
  ["sdd-spec", "sdd-plan", "sdd-task", "sdd-close"].map((s) => [
    `.claude/skills/${s}/SKILL.md`,
    `# ${s}\n`,
  ]),
);
const CUSTOM = { "catspec.yaml": customWorkflowYaml(), ...SKILLS };

/** A spec binding the function `login`. */
const loginSpec = (status = "draft", tasks = "- [x] Write login()\n"): string =>
  specText("login", {
    status,
    extra: "bindings:\n  - id: login\n    symbol: login\n    kind: function\n",
    body: `# Login\n\n## Tasks\n\n${tasks}`,
  });

const withLogin = "export function login(user: string): boolean {\n  return user.length > 0;\n}\n";
const withoutLogin = "export function logout(): void {}\n";

describe("F8 workflow-profiles", () => {
  it("[AC-F8-1] custom sdd skills are gated: next names plan and sdd-plan, close fails with CS0702 until login() exists (spec AC-14)", async () => {
    await inRepo(
      {
        ...CUSTOM,
        "docs/spec/login/spec.md": "# Login\n\nUsers sign in.\n",
        "docs/spec/login/login.spec.md": loginSpec(),
        "src/auth.ts": withoutLogin,
      },
      async (dir) => {
        const next = await catspec(dir, ["next", "login"]);
        expect(next.code, next.stderr).toBe(0);
        expect(next.stdout).toContain("stage plan");
        expect(next.stdout).toContain("skill sdd-plan");

        await writeFile(join(dir, "docs/spec/login/plan.md"), "# Plan\n\n1. login\n", "utf8");
        expect((await catspec(dir, ["stage", "finish", "plan", "login"])).code).toBe(0);
        expect((await catspec(dir, ["stage", "start", "task", "login"])).code).toBe(0);
        expect(await statusOf(dir, "docs/spec/login/login.spec.md")).toBe("in-progress");

        const refused = await catspec(dir, ["stage", "finish", "close", "login"]);
        expect(refused.code).toBe(1);
        expect(refused.stdout).toMatch(/CS0702 .*gate contracts_pass failed/);
        expect(await statusOf(dir, "docs/spec/login/login.spec.md")).toBe("in-progress");

        await writeFile(join(dir, "src/auth.ts"), withLogin, "utf8");
        const closed = await catspec(dir, ["stage", "finish", "close", "login"]);
        expect(closed.code, closed.stdout).toBe(0);
        expect(closed.stdout).toContain("login: in-progress → implemented");
        expect(await statusOf(dir, "docs/spec/login/login.spec.md")).toBe("implemented");
      },
    );
  });

  it("[AC-F8-2] OpenSpec archive is refused while a contract fails or a task is unticked, and the archived spec stays enforced (spec AC-15)", async () => {
    const change = "openspec/changes/add-login";
    await inRepo(
      {
        "catspec.yaml": "workflow:\n  preset: openspec\n",
        [`${change}/proposal.md`]: "# Add login\n",
        [`${change}/tasks.md`]: "## Tasks\n\n- [x] Write login()\n- [ ] Add a test\n",
        [`${change}/login.spec.md`]: loginSpec("ready"),
        "src/auth.ts": withoutLogin,
      },
      async (dir) => {
        const next = await json<NextStep>(dir, ["next", "add-login"]);
        expect(next.stage?.id).toBe("apply");
        expect(next.stage?.driverText).toBe("slash command /opsx:apply");
        expect((await catspec(dir, ["stage", "start", "apply", "add-login"])).code).toBe(0);

        const contract = await catspec(dir, ["stage", "start", "archive", "add-login"]);
        expect(contract.code).toBe(1);
        expect(contract.stdout).toMatch(/CS0701 .*gate contracts_pass failed/);

        await writeFile(join(dir, "src/auth.ts"), withLogin, "utf8");
        const task = await catspec(dir, ["stage", "start", "archive", "add-login"]);
        expect(task.code).toBe(1);
        expect(task.stdout).toMatch(
          /CS0701 .*gate tasks_done failed: 1 open task\(s\) in .*tasks\.md/,
        );

        await writeFile(
          join(dir, change, "tasks.md"),
          "## Tasks\n\n- [x] Write login()\n- [x] Add a test\n",
          "utf8",
        );
        const archived = await catspec(dir, ["stage", "start", "archive", "add-login"]);
        expect(archived.code, archived.stdout).toBe(0);
        expect(await statusOf(dir, `${change}/login.spec.md`)).toBe("implemented");

        // /opsx:archive moves the change; its spec is still checked, as implemented.
        await mkdir(join(dir, "openspec/changes/archive"), { recursive: true });
        await rename(join(dir, change), join(dir, "openspec/changes/archive/2026-10-22-add-login"));
        expect((await catspec(dir, ["check"])).code).toBe(0);
        await writeFile(join(dir, "src/auth.ts"), withoutLogin, "utf8");
        const broken = await catspec(dir, ["check"]);
        expect(broken.code).toBe(1);
        expect(broken.stdout).toContain("CS0201");
        expect(broken.stdout).toContain(
          "openspec/changes/archive/2026-10-22-add-login/login.spec.md",
        );
      },
    );
  });

  it("[AC-F8-3] doctor finds a missing skill: CS0704 names sdd-plan and the expected path (spec AC-16)", async () => {
    const skills = { ...SKILLS };
    delete skills[".claude/skills/sdd-plan/SKILL.md"];
    await inRepo({ "catspec.yaml": customWorkflowYaml(), ...skills }, async (dir) => {
      const doctor = await catspec(dir, ["workflow", "doctor"]);
      expect(doctor.code).toBe(1);
      expect(doctor.stdout).toMatch(
        /CS0704 .*skill sdd-plan not found; expected \.claude\/skills\/sdd-plan\/SKILL\.md/,
      );
      expect(doctor.stdout).toMatch(/catspec\.yaml\n {2}13:\d+/);
    });
  });

  describe("PBI stage-resolution", () => {
    it("closes aggregate specs once their PBIs are implemented, then the whole epic (plan §D17.6 steps 14–15)", async () => {
      const epic = "docs/spec/user-account-management";
      await inRepo(
        {
          ...CUSTOM,
          [`${epic}/spec.md`]: "# Accounts\n",
          [`${epic}/plan.md`]: "# Plan\n",
          [`${epic}/register-api.spec.md`]: specText("register-api", {
            status: "in-progress",
            extra: "bindings:\n  - symbol: register\n    kind: function\n",
          }),
          [`${epic}/registration.spec.md`]: specText("registration", {
            status: "ready",
            dependsOn: ["register-api"],
          }),
          "src/auth.ts": "export function register(): void {}\n",
        },
        async (dir) => {
          // The aggregate has no task stage: it waits for its PBI, then goes to close.
          const before = await json<NextStep>(dir, ["next", "user-account-management"]);
          expect(before.items.find((i) => i.spec === "registration")).toMatchObject({
            stage: "close",
            state: "waiting",
            waitingOn: ["register-api"],
          });
          const task = await catspec(dir, ["stage", "start", "task", "registration"]);
          expect(task.code).toBe(2);
          expect(task.stderr).toContain("aggregate spec");

          expect((await catspec(dir, ["stage", "finish", "close", "register-api"])).code).toBe(0);
          const after = await json<NextStep>(dir, ["next", "user-account-management"]);
          expect(after.items.find((i) => i.spec === "registration")).toMatchObject({
            stage: "close",
            state: "ready",
          });
          const aggregate = await catspec(dir, ["stage", "finish", "close", "registration"]);
          expect(aggregate.code, aggregate.stdout).toBe(0);
          expect(await statusOf(dir, `${epic}/registration.spec.md`)).toBe("implemented");

          const whole = await catspec(dir, ["stage", "finish", "close", "user-account-management"]);
          expect(whole.code, whole.stdout).toBe(0);
          expect(whole.stdout).not.toContain("CS0705");
          expect((await json<NextStep>(dir, ["next", "user-account-management"])).done).toBe(true);
        },
      );
    });

    it("[AC-stage-resolution-1] the current stage follows the artifacts: plan, then task for each ready work item", async () => {
      await inRepo(
        {
          "docs/spec/login/spec.md": "# Login\n",
          "docs/spec/login/login.spec.md": loginSpec(),
          "docs/spec/login/logout.spec.md": specText("logout", {
            extra: "bindings:\n  - symbol: logout\n    kind: function\n",
          }),
          "src/auth.ts": withoutLogin,
        },
        async (dir) => {
          expect((await json<NextStep>(dir, ["next", "login"])).stage?.id).toBe("plan");
          await writeFile(join(dir, "docs/spec/login/plan.md"), "# Plan\n", "utf8");
          expect((await catspec(dir, ["stage", "finish", "plan", "login"])).code).toBe(0);
          const next = await json<NextStep>(dir, ["next", "login"]);
          expect(next.stage?.id).toBe("task");
          expect(next.items).toEqual([
            { spec: "login", status: "ready", stage: "task", state: "ready", waitingOn: [] },
            { spec: "logout", status: "ready", stage: "task", state: "ready", waitingOn: [] },
          ]);
        },
      );
    });

    it("[AC-stage-resolution-2] a per-spec stage on a feature runs for every spec", async () => {
      const ids = [
        "registration",
        "register-api",
        "email-verification",
        "login",
        "login-api",
        "token-refresh",
      ];
      await inRepo(
        Object.fromEntries(
          ids.map((id) => [`docs/spec/user-account-management/${id}.spec.md`, specText(id)]),
        ),
        async (dir) => {
          const result = await json<StageRun>(dir, [
            "stage",
            "finish",
            "close",
            "user-account-management",
          ]);
          expect(result.specs.sort()).toEqual([...ids].sort());
          expect(result.gates.map((g) => g.gate)).toEqual([
            "contracts_pass",
            "tasks_done",
            "no_drift",
          ]);
        },
      );
    });
  });

  describe("PBI gate-runner", () => {
    const files = {
      "catspec.yaml": [
        "workflow:",
        "  preset: custom",
        "  stages:",
        "    - id: check",
        "      per: spec",
        '      produces: ["{feature_dir}/missing.md"]',
        "",
      ].join("\n"),
      "docs/spec/f/ok.spec.md": specText("ok", {
        status: "implemented",
        extra: "bindings:\n  - symbol: login\n    kind: function\n",
        body: "# ok\n\n## Tasks\n\n- [x] done\n",
      }),
      "docs/spec/f/blocked.spec.md": specText("blocked", { dependsOn: ["pending"] }),
      "docs/spec/f/pending.spec.md": specText("pending", { status: "ready" }),
      "docs/spec/f/open.spec.md": specText("open", { body: "# open\n\n## Tasks\n\n- [ ] todo\n" }),
      "src/auth.ts": withLogin,
    };

    async function workflowIn(dir: string, runCommand?: CommandRunner) {
      const { config, root } = await loadConfig(dir);
      const model = await loadSpecModel(root, config);
      const codebase = await loadCodebase(root, config);
      const listed = (await model.source.list()).map((e) => e.path);
      return new Workflow(
        model,
        codebase,
        workflowProfile(config),
        listed,
        runCommand ? { runCommand } : {},
      );
    }

    it.each([
      ["specs_valid", "ok", "pass"],
      ["artifacts", "ok", "fail"],
      ["deps_ready", "blocked", "fail"],
      ["contracts_pass", "ok", "pass"],
      ["tasks_done", "open", "fail"],
      ["no_drift", "ok", "pass"],
    ] as const)("[AC-gate-runner-1] gate %s on %s should %s", async (gate, spec, outcome) => {
      await inRepo(files, async (dir) => {
        const workflow = await workflowIn(dir);
        const stage = workflow.stage("check");
        const target = workflow.model.specs.get(spec)!;
        const result = await workflow.gate(gate, stage, workflow.feature("f"), [target], true);
        expect(result.passed, result.detail).toBe(outcome === "pass");
      });
    });

    it("[AC-gate-runner-2] shell gates are off by default: nothing is executed and CS0706 is reported", async () => {
      await inRepo(files, async (dir) => {
        const runner = vi.fn(() => Promise.resolve({ exitCode: 1, output: "" }));
        const workflow = await workflowIn(dir, runner);
        const result = await workflow.gate(
          { command: "openspec validate {feature}" },
          workflow.stage("check"),
          workflow.feature("f"),
          [workflow.model.specs.get("ok")!],
          true,
        );
        expect(runner).not.toHaveBeenCalled();
        expect(result).toMatchObject({ passed: true, skipped: true });
        expect(result.diagnostics.map((d) => d.code)).toEqual(["CS0706"]);
        expect(result.diagnostics[0]!.message).toContain("openspec validate f");
      });
    });

    it("runs an allowed command gate without a shell, with the placeholders filled in", async () => {
      const allowed = {
        ...files,
        "catspec.yaml": files["catspec.yaml"].replace(
          "workflow:\n",
          "workflow:\n  allow_commands: true\n",
        ),
      };
      await inRepo(allowed, async (dir) => {
        const runner = vi.fn<CommandRunner>(() =>
          Promise.resolve({ exitCode: 3, output: "invalid" }),
        );
        const workflow = await workflowIn(dir, runner);
        const result = await workflow.gate(
          { command: "openspec validate {feature}" },
          workflow.stage("check"),
          workflow.feature("f"),
          [],
          true,
        );
        expect(runner).toHaveBeenCalledWith(dir, ["openspec", "validate", "f"]);
        expect(result).toMatchObject({ passed: false });
        expect(result.detail).toContain("exited with 3");
      });
    });
  });

  describe("command gates on Windows", () => {
    it("don't try to start a batch-script shim (.cmd) without a shell, and say why", async () => {
      await inRepo({ "bin/openspec.cmd": "@exit /b 0\r\n" }, async (dir) => {
        const env = { PATH: join(dir, "bin"), PATHEXT: ".EXE;.CMD" };
        const result = await runCommand(dir, ["openspec", "validate", "x"], 1000, "win32", env);
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("can't start without a shell");
      });
    });
  });

  describe("PBI workflow-cli", () => {
    const account = "docs/spec/user-account-management";
    const accountFiles = (statuses: Record<string, string>) => ({
      ...CUSTOM,
      [`${account}/spec.md`]: "# Accounts\n",
      [`${account}/plan.md`]: "# Plan\n",
      [`${account}/register-api.spec.md`]: specText("register-api", {
        status: statuses["register-api"] ?? "ready",
        extra: "bindings:\n  - symbol: register\n    kind: function\n",
      }),
      [`${account}/email-verification.spec.md`]: specText("email-verification", {
        status: "ready",
        dependsOn: ["register-api"],
        extra: "bindings:\n  - symbol: verify\n    kind: function\n",
      }),
      [`${account}/login-api.spec.md`]: specText("login-api", {
        status: statuses["login-api"] ?? "ready",
        dependsOn: ["register-api"],
        extra: "bindings:\n  - symbol: login\n    kind: function\n",
      }),
      [`${account}/token-refresh.spec.md`]: specText("token-refresh", {
        status: "ready",
        dependsOn: ["login-api"],
        extra: "bindings:\n  - symbol: refresh\n    kind: function\n",
      }),
      "src/auth.ts": "export function register(): void {}\n",
    });

    it("[AC-workflow-cli-1] next lists ready and waiting work items", async () => {
      await inRepo(accountFiles({}), async (dir) => {
        const next = await catspec(dir, ["next", "user-account-management"]);
        expect(next.code, next.stderr).toBe(0);
        expect(next.stdout).toContain("ready: register-api → stage task, use skill sdd-task");
        expect(next.stdout).toContain("waiting: email-verification (on register-api)");
        const data = await json<NextStep>(dir, ["next", "user-account-management"]);
        expect(data.items.find((i) => i.spec === "register-api")).toMatchObject({
          state: "ready",
          stage: "task",
        });
        expect(data.items.find((i) => i.spec === "email-verification")).toMatchObject({
          state: "waiting",
          waitingOn: ["register-api"],
        });
      });
    });

    it("[AC-workflow-cli-2] starting too early is refused with CS0701 naming login-api; --force starts it and logs the override", async () => {
      await inRepo(
        accountFiles({ "register-api": "implemented", "login-api": "in-progress" }),
        async (dir) => {
          const refused = await catspec(dir, ["stage", "start", "task", "token-refresh"]);
          expect(refused.code).toBe(1);
          expect(refused.stdout).toMatch(
            /CS0701 .*gate deps_ready failed: login-api is in-progress, not implemented/,
          );
          const file = `${account}/token-refresh.spec.md`;
          expect(await statusOf(dir, file)).toBe("ready");

          const forced = await catspec(dir, ["stage", "start", "task", "token-refresh", "--force"]);
          expect(forced.code, forced.stdout).toBe(0);
          expect(forced.stderr).toContain("--force overrode CS0701");
          expect(await statusOf(dir, file)).toBe("in-progress");
          const log = await read(dir, ".git/catspec/workflow-overrides.log");
          expect(JSON.parse(log.trim())).toMatchObject({
            phase: "start",
            stage: "task",
            target: "token-refresh",
          });
        },
      );
    });

    it("a refused --force run doesn't claim an override", async () => {
      await inRepo(
        {
          "catspec.yaml": "workflow:\n  preset: openspec\n",
          "openspec/changes/c/proposal.md": "# c\n",
          "openspec/changes/c/tasks.md": "- [x] a\n",
          "openspec/changes/c/login.spec.md": loginSpec("in-progress"),
          "src/auth.ts": withoutLogin,
        },
        async (dir) => {
          const forced = await catspec(dir, ["stage", "start", "archive", "c", "--force"]);
          expect(forced.code).toBe(1);
          expect(forced.stderr).not.toContain("overrode");
          expect(existsSync(join(dir, ".git/catspec/workflow-overrides.log"))).toBe(false);
        },
      );
    });

    it("rejects an unknown stage or target with a usage error and a suggestion", async () => {
      await inRepo(accountFiles({}), async (dir) => {
        const stage = await catspec(dir, ["stage", "start", "tsak", "register-api"]);
        expect(stage.code).toBe(2);
        expect(stage.stderr).toContain('did you mean "task"?');
        const target = await catspec(dir, ["next", "register-ap"]);
        expect(target.code).toBe(2);
        expect(target.stderr).toContain('"register-api"');
      });
    });

    it("workflow show lists the stages and where each feature is; snippet prints the lines for a skill and the AGENTS.md block", async () => {
      await inRepo(accountFiles({}), async (dir) => {
        const show = await catspec(dir, ["workflow", "show"]);
        expect(show.stdout).toContain("preset custom");
        expect(show.stdout).toContain("3. task (per spec)");
        expect(show.stdout).toContain("user-account-management: stage task");
        const snippet = await catspec(dir, ["workflow", "snippet", "task"]);
        expect(snippet.stdout).toContain("catspec stage start task <spec-id>");
        expect(snippet.stdout).toContain("catspec stage finish task <spec-id>");
        expect(snippet.stdout).not.toContain("<spec-id>.spec.md");
        // The stage that writes the machine specs tells the agent what goes into them.
        const spec = await catspec(dir, ["workflow", "snippet", "spec"]);
        expect(spec.stdout.split("\n")[1]).toMatch(/write `<spec-id>\.spec\.md`.*`bindings`/);
        expect(spec.stdout).toContain("catspec bind <ClassName> --spec <spec-id>");
        const agents = await catspec(dir, ["workflow", "snippet", "agents"]);
        expect(agents.stdout).toContain("run `catspec stage start task <id>`");
        expect(agents.stdout).toContain(
          "run `catspec stage finish task <id>`, then `catspec stage finish close <id>`",
        );
      });
    });
  });

  describe("PBI workflow-presets", () => {
    it("[AC-workflow-presets-1] init detects OpenSpec and proposes preset openspec", async () => {
      await inRepo({ "openspec/project.md": "# Project\n" }, async (dir) => {
        const init = await catspec(dir, ["init"]);
        expect(init.code, init.stderr).toBe(0);
        expect(init.stdout).toContain("proposing workflow preset openspec");
        const config = await read(dir, "catspec.yaml");
        expect(config).toContain("preset: openspec");
        // specs.include follows the preset's feature folders (shown as a comment).
        expect(config).toContain('# ["openspec/changes/**/*.spec.md"]');
        expect((await loadConfig(dir)).config.specs.include).toEqual([
          "openspec/changes/**/*.spec.md",
        ]);
        expect((await catspec(dir, ["check", "--specs-only"])).code).toBe(0);
      });
    });

    it("init proposes a preset only when it writes catspec.yaml, and its next step follows the preset", async () => {
      await inRepo(
        { "openspec/project.md": "# Project\n", "catspec.yaml": "version: 1\n" },
        async (dir) => {
          const init = await catspec(dir, ["init"]);
          expect(init.stdout).not.toContain("proposing");
          expect(init.stdout).toContain("skipped catspec.yaml");
        },
      );
      await inRepo({ "openspec/project.md": "# Project\n" }, async (dir) => {
        expect((await catspec(dir, ["init"])).stdout).toContain(
          "Next: start a feature in openspec/changes/<feature>/ (first stage proposal: slash command /opsx:propose)",
        );
      });
    });

    it("init detects Spec Kit and sdd-* skills, and --preset overrides the detection", async () => {
      await inRepo({ ".specify/memory/constitution.md": "# Constitution\n" }, async (dir) => {
        expect((await catspec(dir, ["init"])).stdout).toContain(
          "proposing workflow preset spec-kit",
        );
      });
      await inRepo(SKILLS, async (dir) => {
        expect((await catspec(dir, ["init"])).stdout).toContain("proposing workflow preset custom");
        expect(await read(dir, "catspec.yaml")).toContain("driver: { skill: sdd-plan }");
        expect((await catspec(dir, ["workflow", "doctor"])).code).toBe(0);
      });
      // Only some of the sdd-* skills: the other stages are manual, and doctor still passes.
      const some = {
        ".claude/skills/sdd-spec/SKILL.md": "# sdd-spec\n",
        ".claude/skills/sdd-plan/SKILL.md": "# sdd-plan\n",
      };
      await inRepo(some, async (dir) => {
        expect((await catspec(dir, ["init"])).stdout).toContain("proposing workflow preset custom");
        const config = await read(dir, "catspec.yaml");
        expect(config).toContain("driver: { skill: sdd-plan }");
        expect(config).not.toContain("skill: sdd-task }");
        expect(config).toMatch(/driver: manual {2}# no sdd-task skill found/);
        const doctor = await catspec(dir, ["workflow", "doctor"]);
        expect(doctor.code, doctor.stdout).toBe(0);
      });
      // Skills shared by all agents in .agents/skills, with a plural task skill.
      const shared = Object.fromEntries(
        ["sdd-spec", "sdd-plan", "sdd-tasks", "sdd-close"].map((n) => [
          `.agents/skills/${n}/SKILL.md`,
          `# ${n}\n`,
        ]),
      );
      await inRepo(shared, async (dir) => {
        expect((await catspec(dir, ["init"])).stdout).toContain("proposing workflow preset custom");
        const config = await read(dir, "catspec.yaml");
        expect(config).toContain('skills_dir: ".agents/skills"');
        expect(config).toContain("driver: { skill: sdd-tasks }");
        expect(config).not.toContain("driver: manual");
        const doctor = await catspec(dir, ["workflow", "doctor"]);
        expect(doctor.code, doctor.stdout).toBe(0);
      });
      await inRepo({ "openspec/project.md": "# Project\n" }, async (dir) => {
        const init = await catspec(dir, ["init", "--preset", "catspec"]);
        expect(init.stdout).not.toContain("proposing");
        expect(await read(dir, "catspec.yaml")).toContain("preset: catspec");
      });
    });

    it.each([
      ["catspec", { "docs/spec/login/spec.md": "# Login\n" }],
      [
        "openspec",
        {
          "openspec/project.md": "# Project\n",
          "openspec/changes/add-login/proposal.md": "# Add login\n",
          "openspec/changes/add-login/tasks.md": "- [ ] login\n",
          "openspec/changes/add-login/login.spec.md": loginSpec(),
        },
      ],
      [
        "spec-kit",
        {
          ".specify/memory/constitution.md": "# Constitution\n",
          "specs/001-login/spec.md": "# Login\n",
          "specs/001-login/login.spec.md": loginSpec(),
        },
      ],
      ["custom", SKILLS],
    ] as const)(
      "[AC-workflow-presets-2] preset %s is internally consistent: doctor reports no problems",
      async (preset, files) => {
        await inRepo(
          {
            "catspec.yaml":
              preset === "custom" ? customWorkflowYaml() : `workflow:\n  preset: ${preset}\n`,
            ...files,
          },
          async (dir) => {
            // A stand-in `openspec` program, for the preset's `openspec validate` gate.
            const bin = join(dir, "fake-bin");
            await mkdir(bin, { recursive: true });
            await writeFile(join(bin, "openspec"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
            await writeFile(join(bin, "openspec.cmd"), "@exit /b 0\r\n", "utf8");
            const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
            const doctor = await catspec(dir, ["workflow", "doctor"], env);
            expect(doctor.code, doctor.stdout).toBe(0);
            expect(doctor.stdout).toContain("no problems found");
            expect((await catspec(dir, ["check", "--specs-only"])).code).toBe(0);
            expect((await catspec(dir, ["workflow", "show"])).code).toBe(0);
          },
        );
      },
    );

    it("doctor warns when the preset doesn't match the repository", async () => {
      await inRepo({ "catspec.yaml": "workflow:\n  preset: spec-kit\n" }, async (dir) => {
        const doctor = await catspec(dir, ["workflow", "doctor"]);
        expect(doctor.code).toBe(0);
        expect(doctor.stdout).toMatch(
          /CS0700 workflow\.preset is spec-kit, but the repository has no \.specify\/ folder/,
        );
      });
    });
  });

  describe("PBI workflow-hook", () => {
    const hookConfig = [
      "workflow:",
      "  preset: custom",
      "  allow_commands: true",
      "  enforce_in_hook: error",
      "  stages:",
      "    - id: close",
      "      per: spec",
      "      finish:",
      "        gates: [contracts_pass, tasks_done, { command: \"node -e require('fs').writeFileSync('hook-ran','')\" }]",
      "        status: implemented",
      "",
    ].join("\n");

    it("[AC-workflow-hook-1] shell gates never run in the hook, and the hook stays under 1 second", async () => {
      await withRepo(
        async (repo) => {
          repo.git("add", ".");
          repo.git("commit", "-q", "--no-verify", "-m", "fixture");
          await repo.write({ "src/auth.ts": `${withLogin}// changed\n` });
          repo.git("add", "src");
          // Warm the adapters once, as the hook's own process does on start.
          await catspec(repo.dir, ["check", "--specs-only"]);
          const started = performance.now();
          const hook = await catspec(repo.dir, ["check", "--staged"]);
          const elapsed = performance.now() - started;
          expect(hook.code, hook.stdout + hook.stderr).toBe(0);
          expect(existsSync(join(repo.dir, "hook-ran"))).toBe(false);
          expect(elapsed).toBeLessThan(1000);
        },
        {
          [ADR_LOG]: adrLogText(),
          "catspec.yaml": hookConfig,
          "docs/spec/login/login.spec.md": loginSpec("implemented"),
          "src/auth.ts": withLogin,
        },
      );
    });

    it("reports CS0703 when an implemented spec no longer passes its final gates, with enforce_in_hook's severity", async () => {
      await withRepo(
        async (repo) => {
          repo.git("add", ".");
          repo.git("commit", "-q", "--no-verify", "-m", "fixture");
          await repo.write({
            "docs/spec/login/login.spec.md": loginSpec("implemented", "- [ ] Write login()\n"),
          });
          repo.git("add", ".");
          const hook = await catspec(repo.dir, ["check", "--staged"]);
          expect(hook.code).toBe(1);
          expect(hook.stdout).toMatch(
            /CS0703 "login" is implemented but no longer passes the close gates: tasks_done/,
          );
          expect(existsSync(join(repo.dir, "hook-ran"))).toBe(false);

          await repo.write({ "catspec.yaml": hookConfig.replace("error", "off") });
          repo.git("add", ".");
          expect((await catspec(repo.dir, ["check", "--staged"])).code).toBe(0);
        },
        {
          [ADR_LOG]: adrLogText(),
          "catspec.yaml": hookConfig,
          "docs/spec/login/login.spec.md": loginSpec("implemented"),
          "src/auth.ts": withLogin,
        },
      );
    });
  });

  describe("feature folders at several depths", () => {
    it("feature_dir takes a list: features in domain folders and at the top level; domain folders aren't features", async () => {
      const config = [
        "workflow:",
        "  preset: catspec",
        '  feature_dir: ["docs/spec/{feature}", "docs/spec/billing/{feature}"]',
        "",
      ].join("\n");
      await inRepo(
        {
          "catspec.yaml": config,
          "docs/spec/billing/invoices/spec.md": "# Invoices\n",
          "docs/spec/billing/invoices/invoice-export.spec.md": specText("invoice-export"),
          "docs/spec/login/spec.md": "# Login\n",
          "docs/spec/login/login.spec.md": loginSpec(),
          "src/auth.ts": withLogin,
        },
        async (dir) => {
          const show = await json<{ featureDirs: string[]; features: { feature: string }[] }>(dir, [
            "workflow",
            "show",
          ]);
          expect(show.featureDirs).toEqual(["docs/spec/billing/{feature}", "docs/spec/{feature}"]);
          expect(show.features.map((f) => f.feature)).toEqual(["invoices", "login"]);

          const check = await catspec(dir, ["check", "--specs-only"]);
          expect(check.code, check.stdout).toBe(0);
          expect(check.stdout).not.toContain("CS0106");
          expect((await catspec(dir, ["next", "invoices"])).stdout).toContain(
            "docs/spec/billing/invoices/spec.md",
          );

          // A spec directly in a domain folder is outside every feature folder.
          await writeFile(join(dir, "docs/spec/billing/stray.spec.md"), specText("stray"));
          expect((await catspec(dir, ["check", "--specs-only"])).stdout).toContain("CS0106");
        },
      );
    });
  });
});
