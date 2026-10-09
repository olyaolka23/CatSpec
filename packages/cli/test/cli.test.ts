import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { kebabCase } from "@catspec/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  ADR_LOG,
  adrLogText,
  createRepo,
  specText,
  type TempRepo,
} from "../../../test/temp-repo.js";
import { run } from "../src/index.js";

const bin = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin.js");

const repos: TempRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});
async function repo(files: Record<string, string>): Promise<string> {
  const created = await createRepo(files, { git: true });
  repos.push(created);
  return created.dir;
}

/** Runs the CLI in-process and captures its output. */
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

describe("F1 spec-model", () => {
  it("[AC-F1-1] init creates a working layout that passes check --specs-only", async () => {
    const dir = await repo({});
    const name = kebabCase(basename(dir));

    // The built binary, the way a user runs it.
    const init = spawnSync(process.execPath, [bin, "init"], { cwd: dir, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    expect(existsSync(join(dir, "catspec.yaml"))).toBe(true);
    expect(readdirSync(join(dir, "docs", "spec", "example-feature")).sort()).toEqual([
      "example-greeter.spec.md",
      "plan.md",
      "spec.md",
    ]);
    expect(existsSync(join(dir, "docs", "architecture", "adr", `${name}-adr.md`))).toBe(true);

    const check = spawnSync(process.execPath, [bin, "check", "--specs-only"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.stdout).toContain("0 errors, 0 warnings in 2 specs");
    expect(check.status).toBe(0);

    // Running init again changes nothing.
    const again = await catspec(dir, "init");
    expect(again.code).toBe(0);
    expect(again.stdout).not.toContain("created");
    expect((await catspec(dir, "check", "--specs-only")).code).toBe(0);
  });

  it("[AC-F1-2] reports a binding kind error at the spec file, line 9, with the allowed kinds", async () => {
    const lines = [
      "---", // 1
      "catspec: 1", // 2
      "id: login", // 3
      "type: feature", // 4
      "status: in-progress", // 5
      "bindings:", // 6
      "  - id: service", // 7
      "    symbol: Auth.LoginService", // 8
      "    kind: klass", // 9
      "---",
      "",
      "# Login",
      "",
    ];
    const file = "docs/spec/auth/login.spec.md";
    const dir = await repo({ [ADR_LOG]: adrLogText(), [file]: lines.join("\n") });

    const text = await catspec(dir, "check", "--specs-only");
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`✖ login  ${file}`);
    expect(text.stdout).toContain(
      '9:11  CS0101 bindings[0].kind: invalid value "klass"; allowed: class, interface, struct, enum, record, function, method, type, module',
    );

    const json = await catspec(dir, "check", "--specs-only", "--format", "json");
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout) as {
      diagnostics: { code: string; specLocation: unknown }[];
    };
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      code: "CS0101",
      specLocation: { file, line: 9 },
    });
  });

  it('[AC-F1-3] reports a dependency cycle with its full path "aa → bb → cc → aa"', async () => {
    const dir = await repo({
      [ADR_LOG]: adrLogText(),
      "docs/spec/f/aa.spec.md": specText("aa", { dependsOn: ["bb"] }),
      "docs/spec/f/bb.spec.md": specText("bb", { dependsOn: ["cc"] }),
      "docs/spec/f/cc.spec.md": specText("cc", { dependsOn: ["aa"] }),
    });
    const result = await catspec(dir, "check", "--specs-only");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("CS0105 dependency cycle: aa → bb → cc → aa");
  });

  it("[AC-F1-4] exports the dependency graph as mermaid with one node per spec and one edge per dependency", async () => {
    const dir = await repo({
      [ADR_LOG]: adrLogText(),
      "docs/spec/acc/register-api.spec.md": specText("register-api", { status: "implemented" }),
      "docs/spec/acc/login-api.spec.md": specText("login-api", { dependsOn: ["register-api"] }),
      "docs/spec/acc/token-refresh.spec.md": specText("token-refresh", {
        dependsOn: ["login-api"],
      }),
      "docs/spec/acc/login.spec.md": specText("login", {
        dependsOn: ["login-api", "token-refresh"],
      }),
    });
    const result = await catspec(dir, "graph", "--format", "mermaid");
    expect(result.code).toBe(0);
    const [header, ...lines] = result.stdout.trimEnd().split("\n");
    expect(header).toBe("graph LR");
    const nodes = lines.filter((l) => /^ {2}s_[a-z0-9_]+\["[a-z0-9-]+ · [a-z-]+"\]$/.test(l));
    const edges = lines.filter((l) => /^ {2}s_[a-z0-9_]+ --> s_[a-z0-9_]+$/.test(l));
    expect(nodes.length + edges.length).toBe(lines.length);
    expect(nodes).toHaveLength(5);
    expect(edges.sort()).toEqual(
      [
        "  s_login_api --> s_login",
        "  s_token_refresh --> s_login",
        "  s_register_api --> s_login_api",
        "  s_login_api --> s_token_refresh",
      ].sort(),
    );
    // Every edge connects declared nodes.
    const ids = new Set(nodes.map((n) => n.trim().split("[")[0]));
    for (const edge of edges)
      for (const id of edge.trim().split(" --> ")) expect(ids.has(id)).toBe(true);
  });
});

describe("cli-skeleton", () => {
  const accounts = {
    [ADR_LOG]: adrLogText(),
    "docs/spec/acc/register-api.spec.md": specText("register-api", { status: "implemented" }),
    "docs/spec/acc/login-api.spec.md": specText("login-api", {
      status: "ready",
      dependsOn: ["register-api"],
      body: "# Login API\n\n## Tasks\n- [x] one\n- [ ] two\n",
    }),
    "docs/spec/acc/token-refresh.spec.md": specText("token-refresh", {
      status: "ready",
      dependsOn: ["login-api"],
    }),
  };

  it("[AC-cli-skeleton-1] list --ready lists the spec whose dependency is implemented, not the one waiting", async () => {
    const dir = await repo(accounts);
    const result = await catspec(dir, "list", "--ready");
    expect(result.code).toBe(0);
    const ids = result.stdout
      .trimEnd()
      .split("\n")
      .slice(1)
      .map((line) => line.split(/\s+/)[0]);
    expect(ids).toEqual(["login-api"]);

    const json = JSON.parse((await catspec(dir, "list", "--ready", "--format", "json")).stdout) as {
      id: string;
    }[];
    expect(json.map((r) => r.id)).toEqual(["login-api"]);
  });

  it("[AC-cli-skeleton-2] graph --format png exits 2 and names the allowed formats", async () => {
    const dir = await repo({ [ADR_LOG]: adrLogText() });
    const result = await catspec(dir, "graph", "--format", "png");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("mermaid, dot, json");
    expect(result.stdout).toBe("");
  });

  it("lists specs with status, tasks and dependencies, and filters by status", async () => {
    const dir = await repo(accounts);
    const all = await catspec(dir, "list");
    expect(all.stdout.split("\n")[0]).toMatch(/^ID\s+STATUS\s+TASKS\s+DEPENDS ON\s+TITLE$/);
    expect(all.stdout).toMatch(/login-api\s+ready\s+1\/2\s+register-api/);
    const implemented = JSON.parse(
      (await catspec(dir, "list", "--status", "implemented", "--format", "json")).stdout,
    ) as {
      id: string;
    }[];
    expect(implemented.map((r) => r.id)).toEqual(["register-api"]);
    expect((await catspec(dir, "list", "--status", "done")).code).toBe(2);
  });

  it("shows one spec, and exits 2 with a suggestion for an unknown id", async () => {
    const dir = await repo(accounts);
    const text = await catspec(dir, "show", "login-api");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("login-api — Login API");
    expect(text.stdout).toMatch(/depends on\s+register-api \(implemented\)/);
    expect(text.stdout).toMatch(/needed by\s+token-refresh/);
    expect(text.stdout).toMatch(/tasks\s+1\/2/);

    const json = JSON.parse(
      (await catspec(dir, "show", "login-api", "--format", "json")).stdout,
    ) as Record<string, unknown>;
    expect(json).toMatchObject({
      id: "login-api",
      ready: true,
      dependents: ["token-refresh"],
      tasks: { done: 1, total: 2 },
    });

    const unknown = await catspec(dir, "show", "login-apii");
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('did you mean "login-api"?');
  });

  it("exports dot and json graphs, focused on one spec", async () => {
    const dir = await repo(accounts);
    const dot = await catspec(dir, "graph", "--format", "dot", "--focus", "token-refresh");
    expect(dot.stdout).toContain('"login-api" -> "token-refresh";');
    expect(dot.stdout).not.toContain('"architecture"');
    const json = JSON.parse((await catspec(dir, "graph", "--format", "json")).stdout) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(json.nodes).toHaveLength(4);
    expect(json.edges).toEqual([
      { spec: "login-api", dependsOn: "register-api" },
      { spec: "token-refresh", dependsOn: "login-api" },
    ]);
  });

  it("uses exit code 2 for config and usage errors, and honours --cwd and --config", async () => {
    const dir = await repo({
      [ADR_LOG]: adrLogText(),
      "catspec.yaml": "heal:\n  mode: sometimes\n",
    });
    const config = await catspec(dir, "check", "--specs-only");
    expect(config.code).toBe(2);
    expect(config.stderr).toContain("catspec.yaml:2:9: heal.mode");
    expect(config.stderr).toContain("off, suggest, auto");

    const other = await repo({ [ADR_LOG]: adrLogText(), "alt.yaml": "layout: free\n" });
    const viaFlags = await catspec(
      dir,
      "--cwd",
      other,
      "--config",
      "alt.yaml",
      "check",
      "--specs-only",
    );
    expect(viaFlags.code).toBe(0);

    expect((await catspec(dir, "check")).code).toBe(2);
    expect((await catspec(dir, "--cwd", join(dir, "missing"), "list")).code).toBe(2);
    expect((await catspec(dir, "nope")).code).toBe(2);
    expect((await catspec(dir, "--version")).code).toBe(0);
    const help = await catspec(dir, "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("check");
  });
});
