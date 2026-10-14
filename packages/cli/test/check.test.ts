/**
 * `catspec check`, `status` and `coverage` end to end (feature F3 `rule-engine-and-check`, PBIs
 * `check-command`, `status-and-waivers`, `query-and-test-rules` and `dogfood-specs`).
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ADR_LOG,
  adrLogText,
  createRepo,
  specText,
  type TempRepo,
} from "../../../test/temp-repo.js";
import { run } from "../src/index.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const repos: TempRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});
async function repo(files: Record<string, string>): Promise<string> {
  const created = await createRepo({ [ADR_LOG]: adrLogText(), ...files }, { git: true });
  repos.push(created);
  return created.dir;
}

async function catspec(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    cwd,
    env: {},
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

const AUTH_SPEC = (status: string): string =>
  specText("auth-service", {
    status,
    extra: `bindings:
  - id: auth
    symbol: AuthService
    kind: class
    file: src/auth/AuthService.ts
    members:
      - name: validateToken
        kind: method
        params: [string]
        returns: boolean
      - login
`,
  });

const AUTH_CODE = (method = "validateToken"): string =>
  `export class AuthService {
  login(user: string): boolean {
    return this.${method}(user);
  }

  ${method}(token: string): boolean {
    return token.length > 0;
  }
}
`;

describe("F3 rule-engine-and-check", () => {
  it("[AC-F3-1] catches a renamed method with CS0203 and did-you-mean with the file and line (spec AC-1)", async () => {
    const dir = await repo({
      "docs/spec/auth/auth-service.spec.md": AUTH_SPEC("implemented"),
      "src/auth/AuthService.ts": AUTH_CODE(),
    });
    expect((await catspec(dir, "check")).code).toBe(0);

    await writeFile(join(dir, "src/auth/AuthService.ts"), AUTH_CODE("checkToken"));
    const { code, stdout } = await catspec(dir, "check");
    expect(code).toBe(1);
    expect(stdout).toContain("CS0203 member validateToken missing");
    expect(stdout).toContain("did you mean checkToken? (src/auth/AuthService.ts:6:3)");
  });

  it("[AC-F3-2] reports CS0603 with the importing file and line for an architecture rule (spec AC-6)", async () => {
    const dir = await repo({
      [ADR_LOG]: adrLogText(
        ["ADR-001"],
        `rules:
  - id: domain-no-infrastructure
    adr: ADR-001
    class: structural
    forbid_import:
      from: "src/Domain/**"
      to: ["src/Infrastructure/**"]
`,
      ).replace("status: draft", "status: implemented"),
      "src/Domain/User.ts": '\nimport { Db } from "../Infrastructure/Db";\nexport class User {}\n',
      "src/Infrastructure/Db.ts": "export class Db {}\n",
    });
    const { code, stdout } = await catspec(dir, "check");
    expect(code).toBe(1);
    expect(stdout).toContain("CS0603 src/Domain/User.ts imports ../Infrastructure/Db");
    expect(stdout).toContain("at src/Domain/User.ts:2:1");
  });

  it("[AC-F3-3] refuses an in-progress status with CS0502 naming the unimplemented dependency (spec AC-7)", async () => {
    const dir = await repo({
      "docs/spec/sync/user-sync-handler.spec.md": specText("user-sync-handler", {
        status: "ready",
        dependsOn: ["cdc-core-events"],
      }),
      "docs/spec/sync/cdc-core-events.spec.md": specText("cdc-core-events", {
        status: "in-progress",
      }),
    });
    const { code, stdout, stderr } = await catspec(
      dir,
      "status",
      "user-sync-handler",
      "in-progress",
    );
    expect(code).toBe(1);
    expect(stdout).toContain("CS0502");
    expect(stdout).toContain("cdc-core-events is in-progress, not implemented");
    expect(stderr).toContain("refused");
    const text = await readFile(join(dir, "docs/spec/sync/user-sync-handler.spec.md"), "utf8");
    expect(text).toContain("status: ready");
  });

  it("[AC-F3-4] ends the --spec report with DONE (exit 0), or with expected, found, fix and NOT DONE (exit 1)", async () => {
    const dir = await repo({
      "docs/spec/auth/auth-service.spec.md": AUTH_SPEC("in-progress"),
      "src/auth/AuthService.ts": AUTH_CODE(),
    });
    const done = await catspec(dir, "check", "--spec", "auth-service");
    expect(done.code).toBe(0);
    expect(done.stdout.trimEnd().split("\n").pop()).toBe("DONE");

    await writeFile(join(dir, "src/auth/AuthService.ts"), AUTH_CODE("checkToken"));
    const notDone = await catspec(dir, "check", "--spec", "auth-service");
    expect(notDone.code).toBe(1);
    const lines = notDone.stdout.trimEnd().split("\n");
    expect(lines.pop()).toBe("NOT DONE");
    expect(notDone.stdout).toContain("expected: method validateToken(string): boolean");
    expect(notDone.stdout).toContain("found:    method checkToken(token: string): boolean");
    expect(notDone.stdout).toContain("fix:      did you mean checkToken?");
  });

  it("[AC-F3-5] fails catspec check with CS0603 when packages/core imports web-tree-sitter (ADR-003)", async () => {
    const dir = await copyOfThisRepository();
    const binArgs = [
      "--conditions=source",
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      join(repoRoot, "packages", "cli", "src", "bin.ts"),
      "check",
    ];
    const clean = spawnSync(process.execPath, binArgs, { cwd: dir, encoding: "utf8" });
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);

    await writeFile(
      join(dir, "packages/core/src/parser.ts"),
      'import { Parser } from "web-tree-sitter";\nexport const parser = Parser;\n',
    );
    const broken = spawnSync(process.execPath, binArgs, { cwd: dir, encoding: "utf8" });
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain("CS0603 packages/core/src/parser.ts imports web-tree-sitter");
    expect(broken.stdout).toContain("core-has-no-parser-dependency");
    expect(broken.stdout).toContain("ADR-003");
  }, 60_000);
});

/**
 * A copy of this repository's `catspec.yaml`, ADR log and package sources, with the ADR log
 * enforced: still `draft` on main until the owner approves switching it (PBI `dogfood-specs`).
 */
async function copyOfThisRepository(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "catspec-self-"));
  repos.push({ dir, cleanup: () => rm(dir, { recursive: true, force: true }) });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  await cp(join(repoRoot, "catspec.yaml"), join(dir, "catspec.yaml"));
  const log = "docs/architecture/adr/reactive-ast-adr.md";
  const text = await readFile(join(repoRoot, log), "utf8");
  await cp(join(repoRoot, log), join(dir, log));
  await writeFile(join(dir, log), text.replace(/^status: draft\b/m, "status: implemented"));
  await cp(join(repoRoot, "packages"), join(dir, "packages"), {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist|grammars|test)$/.test(source),
  });
  return dir;
}

describe("PBI check-command", () => {
  it("[AC-check-command-1] reports CS0203 with did-you-mean and the code location (spec AC-1)", async () => {
    const dir = await repo({
      "docs/spec/auth/auth-service.spec.md": AUTH_SPEC("implemented"),
      "src/auth/AuthService.ts": AUTH_CODE("checkToken"),
    });
    const { code, stdout } = await catspec(dir, "check");
    expect(code).toBe(1);
    // The wording is part of the UX: a change here is a deliberate change of the report.
    expect(stdout).toBe(
      [
        "✔ architecture  docs/architecture/adr/test-adr.md",
        "✖ auth-service  docs/spec/auth/auth-service.spec.md",
        "  12:9  CS0203 member validateToken missing in AuthService",
        "               at src/auth/AuthService.ts:1:14",
        "               ↳ did you mean checkToken? (src/auth/AuthService.ts:6:3)",
        "               ↳ add validateToken to AuthService, or update the spec",
        "1 error, 0 warnings in 2 specs",
        "",
      ].join("\n"),
    );
  });

  it("[AC-check-command-2] reports 75% contract satisfaction and 80% enforcement coverage", async () => {
    const dir = await repo({
      "docs/spec/rules/coverage-rules.spec.md": specText("coverage-rules", {
        status: "in-progress",
        extra: `scope: ["src/**"]
rules:
  - { id: no-console, class: structural, forbid_call: "console.*" }
  - { id: no-eval, class: structural, forbid_call: eval }
  - { id: calls-main, class: structural, require_call: main }
  - { id: no-legacy, class: structural, must_not_exist: { symbol: LegacyApi } }
  - { id: reviewed, class: manual, text: A person reviews the error messages. }
`,
      }),
      "src/main.ts": 'export function main() {\n  return eval("1");\n}\nmain();\n',
    });
    const { code, stdout } = await catspec(dir, "coverage", "--format", "json");
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      satisfaction: { percent: number };
      enforcement: { percent: number; manual: number };
    };
    expect(report.satisfaction.percent).toBe(75);
    expect(report.enforcement.percent).toBe(80);
    expect(report.enforcement.manual).toBe(1);

    const text = await catspec(dir, "coverage");
    expect(text.stdout).toContain("contract satisfaction  75%  (3 of 4 enforceable items pass)");
    expect(text.stdout).toContain(
      "enforcement coverage   80%  (4 enforceable, 1 manual, 0 unenforced prose)",
    );
  });

  it("limits the report to the given paths and rejects unknown spec ids", async () => {
    const dir = await repo({
      "docs/spec/auth/auth-service.spec.md": AUTH_SPEC("implemented"),
      "src/auth/AuthService.ts": AUTH_CODE("checkToken"),
    });
    expect((await catspec(dir, "check", "src/other")).code).toBe(0);
    expect((await catspec(dir, "check", "src/auth")).code).toBe(1);
    const unknown = await catspec(dir, "check", "--spec", "auth-servic");
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('did you mean "auth-service"?');
    const noCommand = await catspec(dir, "check", "--run-tests");
    expect(noCommand.code).toBe(2);
    expect(noCommand.stderr).toContain("tests.command");
  });
});

describe("PBI status-and-waivers", () => {
  it("[AC-status-and-waivers-1] reports CS0203 of an in-progress spec as a warning, exit 0", async () => {
    const dir = await repo({
      "docs/spec/auth/auth-service.spec.md": AUTH_SPEC("in-progress"),
      "src/auth/AuthService.ts": AUTH_CODE("checkToken"),
    });
    const { code, stdout } = await catspec(dir, "check");
    expect(code).toBe(0);
    expect(stdout).toContain("⚠ auth-service");
    expect(stdout).toContain("CS0203 member validateToken missing");
    expect(stdout).toContain("0 errors, 1 warning");
  });

  it("[AC-status-and-waivers-3] refuses implemented while a contract fails and lists it", async () => {
    const dir = await repo({
      "docs/spec/auth/auth-service.spec.md": AUTH_SPEC("in-progress"),
      "src/auth/AuthService.ts": AUTH_CODE("checkToken"),
    });
    const refused = await catspec(dir, "status", "auth-service", "implemented");
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("CS0203 member validateToken missing");

    await writeFile(join(dir, "src/auth/AuthService.ts"), AUTH_CODE());
    const accepted = await catspec(dir, "status", "auth-service", "implemented");
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toBe("auth-service: in-progress → implemented\n");
    const text = await readFile(join(dir, "docs/spec/auth/auth-service.spec.md"), "utf8");
    expect(text).toBe(AUTH_SPEC("implemented"));
  });

  it("lets --force skip the dependency gate", async () => {
    const dir = await repo({
      "docs/spec/sync/user-sync-handler.spec.md": specText("user-sync-handler", {
        status: "ready",
        dependsOn: ["cdc-core-events"],
      }),
      "docs/spec/sync/cdc-core-events.spec.md": specText("cdc-core-events", { status: "draft" }),
    });
    const { code } = await catspec(dir, "status", "user-sync-handler", "in-progress", "--force");
    expect(code).toBe(0);
  });
});

describe("PBI query-and-test-rules", () => {
  it("[AC-query-and-test-rules-1] reports CS0130 at an invalid query when the specs load, before any code is parsed", async () => {
    const dir = await repo({
      "docs/spec/q/queries.spec.md": specText("queries", {
        status: "implemented",
        extra: `rules:
  - id: broken
    class: query
    lang: typescript
    query: "(call_expression function: (identifier) @f"
`,
      }),
      // Never read with --specs-only; a syntax error here would show up as CS0901 otherwise.
      "src/broken.ts": "export class {",
    });
    const { code, stdout } = await catspec(dir, "check", "--specs-only");
    expect(code).toBe(1);
    expect(stdout).toContain('10:12  CS0130 rule "broken": invalid typescript query');
    expect(stdout).not.toContain("CS0901");
  });
});

describe("PBI dogfood-specs", () => {
  it("[AC-dogfood-specs-1] checks this repository's ADR rules: CS0603 when packages/core imports web-tree-sitter (ADR-003)", async () => {
    const dir = await copyOfThisRepository();
    expect((await catspec(dir, "check")).code).toBe(0);
    await writeFile(
      join(dir, "packages/core/src/load.ts"),
      `import "web-tree-sitter";\n${await readFile(join(dir, "packages/core/src/load.ts"), "utf8")}`,
    );
    const { code, stdout } = await catspec(dir, "check");
    expect(code).toBe(1);
    expect(stdout).toContain("CS0603 packages/core/src/load.ts imports web-tree-sitter");
  }, 60_000);

  it("passes catspec check on this repository, as the CI step does", async () => {
    const { code, stdout } = await catspec(repoRoot, "check");
    expect(stdout).toContain("0 errors");
    expect(code).toBe(0);
  }, 60_000);
});
