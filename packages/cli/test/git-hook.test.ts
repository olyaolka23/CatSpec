/**
 * Feature F5 `git-integration-and-hook` end to end: the pre-commit hook on real commits, the
 * staged check, lock files with the ratchet and drift, and the hook installer (PBIs
 * `git-access`, `source-providers`, `staged-check`, `lock-files`, `ratchet`, `drift-and-accept`,
 * `hook-installer`).
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkCode,
  Git,
  IndexProvider,
  loadConfig,
  loadSpecModel,
  RevisionProvider,
  WorkingTreeProvider,
  type SourceProvider,
} from "@catspec/core";
import { describe, expect, it } from "vitest";

import { ADR_LOG, adrLogText, specText, withRepo, type GitRepo } from "../../../test/temp-repo.js";
import { loadCodebase } from "../src/codebase.js";
import { run } from "../src/index.js";
import { checkStaged } from "../src/staged.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
/**
 * The `catspec` bin entry run from source: the monorepo test rebuilds `dist/` (and empties it
 * first) while the tests run in parallel.
 */
const posix = (path: string): string => path.replace(/\\/g, "/");
const BIN_ARGS = [
  "--conditions=source",
  "--import",
  pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
  posix(join(repoRoot, "packages", "cli", "src", "bin.ts")),
];

async function catspec(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    cwd,
    env,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

/** The built CLI as `node_modules/.bin/catspec`, which the installed hook runs. */
async function installCli(dir: string): Promise<void> {
  const shim = join(dir, "node_modules", ".bin", "catspec");
  await mkdir(join(shim, ".."), { recursive: true });
  await writeFile(
    shim,
    `#!/bin/sh\nexec node ${BIN_ARGS.map((a) => `"${a}"`).join(" ")} "$@"\n`,
    "utf8",
  );
  await chmod(shim, 0o755);
}

/** Real commits run the hook, which starts the CLI through the TypeScript loader each time. */
const HOOK_TIMEOUT = 60_000;

const AUTH = "src/auth/AuthService.ts";
const AUTH_SPEC_FILE = "docs/spec/auth/auth-service.spec.md";
const AUTH_LOCK = "docs/spec/auth/auth-service.lock.json";

/** A spec bound to `AuthService` with member `login`; `member` overrides its YAML entry. */
const authSpec = (status: string, member = "- login"): string =>
  specText("auth-service", {
    status,
    extra: `bindings:
  - id: auth
    symbol: AuthService
    kind: class
    members:
      ${member}
`,
  });

const authCode = (members: string): string => `export class AuthService {\n${members}}\n`;
const LOGIN = "  login(user: string): boolean {\n    return user.length > 0;\n  }\n";
const LOGOUT = "  logout(): void {}\n";

const lockOf = async (dir: string): Promise<{ satisfied: string[] }> =>
  JSON.parse(await readFile(join(dir, AUTH_LOCK), "utf8")) as { satisfied: string[] };

/** A repository with the ADR log, the auth spec and code, and the CLI the hook runs. */
async function authRepo(
  repo: GitRepo,
  status: string,
  code: string,
  member?: string,
): Promise<void> {
  await repo.write({
    [ADR_LOG]: adrLogText(),
    [AUTH_SPEC_FILE]: authSpec(status, member),
    [AUTH]: code,
  });
  await installCli(repo.dir);
}

describe("F5 git-integration-and-hook", { timeout: HOOK_TIMEOUT }, () => {
  it("[AC-F5-1] the hook warns about work in progress but blocks a regression with CS0301 (spec AC-4)", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "in-progress", authCode(LOGOUT));
      expect((await catspec(repo.dir, ["install-hooks"])).code).toBe(0);
      repo.git("add", "docs", "src");

      const first = repo.commit("auth service without login");
      expect(first.code, first.output).toBe(0);
      expect(first.output).toContain("CS0203 member login missing");
      expect(repo.git("show", "--name-only", "--format=", "HEAD")).toContain(AUTH_LOCK);

      await repo.write({ [AUTH]: authCode(LOGOUT + LOGIN) });
      repo.git("add", AUTH);
      expect(repo.commit("implement login").code).toBe(0);
      expect((await lockOf(repo.dir)).satisfied).toContain("binding:auth.login");

      await repo.write({ [AUTH]: authCode(LOGOUT) });
      repo.git("add", AUTH);
      const regression = repo.commit("delete login");
      expect(regression.code).not.toBe(0);
      expect(regression.output).toContain(
        "CS0301 regression: binding:auth.login passed before and now fails: CS0203",
      );
      expect(repo.git("log", "--format=%s", "-1").trim()).toBe("implement login");
    });
  });

  it("[AC-F5-2] the hook checks the staged version of a file, not the working tree (spec AC-5)", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "implemented", authCode(LOGIN));
      await catspec(repo.dir, ["install-hooks"]);
      repo.git("add", "docs", "src");
      await repo.write({ [AUTH]: authCode(LOGOUT) });
      const passing = repo.commit("correct version staged");
      expect(passing.code, passing.output).toBe(0);

      await repo.write({ [AUTH]: authCode(LOGOUT) });
      repo.git("add", AUTH);
      await repo.write({ [AUTH]: authCode(LOGIN) });
      const failing = repo.commit("broken version staged");
      expect(failing.code).not.toBe(0);
      expect(failing.output).toContain("member login missing");
    });
  });

  it("[AC-F5-4] with husky, install-hooks keeps the existing pre-commit script and both run", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "implemented", authCode(LOGIN));
      // What `husky` (v9) sets up: core.hooksPath .husky/_ whose pre-commit runs .husky/pre-commit.
      await repo.write({
        ".husky/pre-commit": 'echo "existing hook ran" > existing-hook.txt\n',
        ".husky/_/pre-commit": '#!/bin/sh\nsh -e .husky/pre-commit "$@"\n',
      });
      await chmod(join(repo.dir, ".husky/_/pre-commit"), 0o755);
      repo.git("config", "core.hooksPath", ".husky/_");

      const install = await catspec(repo.dir, ["install-hooks"]);
      expect(install.code, install.stderr).toBe(0);
      expect(install.stdout).toContain("husky");
      const hook = await readFile(join(repo.dir, ".husky/pre-commit"), "utf8");
      expect(hook.startsWith('echo "existing hook ran" > existing-hook.txt\n')).toBe(true);

      repo.git("add", "docs", "src");
      const commit = repo.commit("both hooks");
      expect(commit.code, commit.output).toBe(0);
      expect(existsSync(join(repo.dir, "existing-hook.txt"))).toBe(true);
      // CatSpec ran: it wrote and staged the spec's lock file.
      expect(repo.git("show", "--name-only", "--format=", "HEAD")).toContain(AUTH_LOCK);

      await repo.write({ [AUTH]: authCode(LOGOUT) });
      repo.git("add", AUTH);
      expect(repo.commit("broken").code).not.toBe(0);

      expect((await catspec(repo.dir, ["uninstall-hooks"])).code).toBe(0);
      expect(await readFile(join(repo.dir, ".husky/pre-commit"), "utf8")).toBe(
        'echo "existing hook ran" > existing-hook.txt\n',
      );
    });
  });

  it("[AC-git-access-1] reads a staged file with a hostile name without running anything", async () => {
    const name = "src/a;rm -rf ~;$(touch pwned).ts";
    await withRepo(async (repo) => {
      await repo.write({
        [ADR_LOG]: adrLogText(),
        "docs/spec/odd/odd.spec.md": specText("odd", {
          status: "implemented",
          extra: "bindings:\n  - symbol: Odd\n    kind: class\n    members: [run]\n",
        }),
        [name]: "export class Odd {\n  run(): void {}\n}\n",
      });
      repo.git("add", "--", "docs", name);

      const git = new Git(repo.dir);
      try {
        const index = new IndexProvider(git);
        expect((await index.list()).map((e) => e.path)).toContain(name);
        expect((await index.read(name))?.toString("utf8")).toContain("export class Odd");
      } finally {
        await git.close();
      }
      const { code, stdout } = await catspec(repo.dir, ["check", "--staged"]);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain("✔ odd");
      expect(existsSync(join(repo.dir, "pwned"))).toBe(false);
      expect(existsSync(join(repo.dir, "src", "pwned"))).toBe(false);
    });
  });

  it("[AC-git-access-2] check --staged without git reports CS0902 and exits with 1", async () => {
    const empty = await mkdtemp(join(tmpdir(), "catspec-no-git-"));
    try {
      await withRepo(async (repo) => {
        await repo.write({ [ADR_LOG]: adrLogText() });
        const { code, stdout } = await catspec(repo.dir, ["check", "--staged"], { PATH: empty });
        expect(stdout).toContain("CS0902");
        expect(stdout).toContain("git is required");
        expect(code).toBe(1);
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("[AC-source-providers-1] the working tree, the index and HEAD give identical diagnostics", async () => {
    await withRepo(async (repo) => {
      await repo.write({
        [ADR_LOG]: adrLogText(),
        [AUTH_SPEC_FILE]: authSpec(
          "implemented",
          "- { name: login, kind: method, params: [number] }\n      - validate",
        ),
        [AUTH]: authCode(LOGIN),
        "src/auth/Broken.ts": "export class Broken {\n  oops( {\n}\n",
      });
      repo.git("add", ".");
      repo.git("commit", "-q", "--no-verify", "-m", "snapshot");

      const { config, root } = await loadConfig(repo.dir);
      const git = new Git(root);
      try {
        const results: string[] = [];
        const sources: SourceProvider[] = [
          new WorkingTreeProvider(root),
          new IndexProvider(git),
          new RevisionProvider(git, "HEAD"),
        ];
        for (const source of sources) {
          const model = await loadSpecModel(root, config, source);
          const codebase = await loadCodebase(root, config, { source });
          results.push(JSON.stringify((await checkCode(model, codebase)).diagnostics));
        }
        expect(results[0]).toContain("CS0205");
        expect(results[0]).toContain("CS0203");
        expect(results[1]).toBe(results[0]);
        expect(results[2]).toBe(results[0]);
      } finally {
        await git.close();
      }
    });
  });

  it("[AC-staged-check-1] check --staged passes on a correct staged version and fails on a broken one (spec AC-5)", async () => {
    await withRepo(async (repo) => {
      await repo.write({
        [ADR_LOG]: adrLogText(),
        [AUTH_SPEC_FILE]: authSpec("implemented"),
        [AUTH]: authCode(LOGIN),
      });
      repo.git("add", ".");
      await repo.write({ [AUTH]: authCode(LOGOUT) });
      expect((await catspec(repo.dir, ["check", "--staged"])).code).toBe(0);
      expect((await catspec(repo.dir, ["check"])).code).toBe(1);

      repo.git("add", AUTH);
      await repo.write({ [AUTH]: authCode(LOGIN) });
      const staged = await catspec(repo.dir, ["check", "--staged"]);
      expect(staged.code).toBe(1);
      expect(staged.stdout).toContain("CS0203 member login missing");
      expect((await catspec(repo.dir, ["check"])).code).toBe(0);
    });
  });

  it("[AC-staged-check-2] a commit changing one bound file evaluates only that file and its spec", async () => {
    const count = 1000;
    const files: Record<string, string> = { [ADR_LOG]: adrLogText() };
    for (let i = 0; i < count; i++) {
      files[`docs/spec/f${i}/s${i}.spec.md`] = specText(`s${i}`, {
        status: "implemented",
        extra: `bindings:\n  - symbol: Service${i}\n    kind: class\n    members: [run]\n`,
      });
      files[`src/s${i}/Service${i}.ts`] = `export class Service${i} {\n  run(): void {}\n}\n`;
    }
    await withRepo(async (repo) => {
      expect((await catspec(repo.dir, ["baseline", "--rebuild"])).code).toBe(0);
      repo.git("add", ".");
      repo.git("commit", "-q", "--no-verify", "-m", "baseline");

      await repo.write({
        "src/s42/Service42.ts":
          "export class Service42 {\n  run(): void {}\n  stop(): void {}\n}\n",
      });
      repo.git("add", "src/s42/Service42.ts");
      const { config, root } = await loadConfig(repo.dir);
      const staged = await checkStaged(root, config);
      try {
        expect(staged.result.checked.map((s) => s.id)).toEqual(["s42"]);
        expect(staged.files).toEqual(["src/s42/Service42.ts"]);
        expect(staged.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      } finally {
        await staged.git.close();
      }
    }, files);
  }, 120_000);

  it("[AC-lock-files-1] baseline --rebuild writes byte-identical lock files when nothing changed", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "implemented", authCode(LOGIN + LOGOUT));
      const first = await catspec(repo.dir, ["baseline", "--rebuild"]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`wrote ${AUTH_LOCK}`);
      const before = await readFile(join(repo.dir, AUTH_LOCK));
      const second = await catspec(repo.dir, ["baseline", "--rebuild"]);
      expect(second.stdout).toContain("the lock files are up to date");
      await rm(join(repo.dir, AUTH_LOCK));
      await catspec(repo.dir, ["baseline", "--rebuild"]);
      const after = await readFile(join(repo.dir, AUTH_LOCK));
      expect(after.equals(before)).toBe(true);
      expect(after.toString("utf8")).not.toContain("\r");
      const lock = JSON.parse(after.toString("utf8")) as Record<string, unknown>;
      expect(Object.keys(lock)).toEqual(["spec", "specHash", "items", "satisfied", "symbols"]);
      expect(lock.satisfied).toEqual(["binding:auth", "binding:auth.login"]);
    });
  });

  it("[AC-lock-files-2] a lock file without its spec is CS0108", async () => {
    await withRepo(async (repo) => {
      await repo.write({
        [ADR_LOG]: adrLogText(),
        "docs/spec/auth/login.lock.json": "{}\n",
      });
      const { code, stdout } = await catspec(repo.dir, ["check", "--specs-only"]);
      expect(stdout).toContain("CS0108 docs/spec/auth/login.lock.json has no spec");
      expect(code).toBe(0);
    });
  });

  it("[AC-ratchet-1] deleting a member that passed before is CS0301 in an in-progress spec (spec AC-4)", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "in-progress", authCode(LOGIN));
      await catspec(repo.dir, ["baseline", "--rebuild"]);
      expect((await lockOf(repo.dir)).satisfied).toContain("binding:auth.login");

      await repo.write({ [AUTH]: authCode(LOGOUT) });
      const { code, stdout } = await catspec(repo.dir, ["check"]);
      expect(code).toBe(1);
      expect(stdout).toContain("✖ auth-service");
      expect(stdout).toContain("CS0301 regression: binding:auth.login passed before");
    });
  });

  it("[AC-ratchet-2] changing a member's declared return type removes it from satisfied until it passes again", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "in-progress", authCode(LOGIN), "- { name: login, returns: boolean }");
      await catspec(repo.dir, ["baseline", "--rebuild"]);
      repo.git("add", ".");
      repo.git("commit", "-q", "--no-verify", "-m", "login satisfied");
      expect((await lockOf(repo.dir)).satisfied).toContain("binding:auth.login");

      await repo.write({
        [AUTH_SPEC_FILE]: authSpec("in-progress", "- { name: login, returns: string }"),
      });
      repo.git("add", AUTH_SPEC_FILE);
      const changed = await catspec(repo.dir, ["check", "--staged"]);
      expect(changed.code).toBe(0);
      expect(changed.stdout).toContain("⚠ auth-service");
      expect(changed.stdout).toContain("CS0205");
      expect(changed.stdout).not.toContain("CS0301");
      expect((await lockOf(repo.dir)).satisfied).not.toContain("binding:auth.login");

      await repo.write({ [AUTH]: authCode(LOGIN.replace("boolean", "string")) });
      repo.git("add", AUTH);
      expect((await catspec(repo.dir, ["check", "--staged"])).code).toBe(0);
      expect((await lockOf(repo.dir)).satisfied).toContain("binding:auth.login");
    });
  });

  it("[AC-drift-and-accept-1] a body change is not drift, a signature change is CS0300", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "implemented", authCode(LOGIN));
      await catspec(repo.dir, ["baseline", "--rebuild"]);

      await repo.write({ [AUTH]: authCode(LOGIN.replace("user.length > 0", "user !== ''")) });
      const body = await catspec(repo.dir, ["check"]);
      expect(body.code).toBe(0);
      expect(body.stdout).not.toContain("CS0300");

      await repo.write({
        [AUTH]: authCode(LOGIN.replace("login(user: string)", "login(user: string, otp: string)")),
      });
      const signature = await catspec(repo.dir, ["check"]);
      expect(signature.stdout).toContain("CS0300");
      expect(signature.stdout).toContain(
        "- member method login(string):boolean, + member method login(string,string):boolean",
      );
      expect(signature.code).toBe(0);
    });
  });

  it("[AC-drift-and-accept-2] catspec accept records the change and the next check reports no drift", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "implemented", authCode(LOGIN));
      await catspec(repo.dir, ["baseline", "--rebuild"]);
      await repo.write({
        [AUTH]: authCode(LOGIN.replace("login(user: string)", "login(user: string, otp: string)")),
      });
      expect((await catspec(repo.dir, ["check"])).stdout).toContain("CS0300");

      const accept = await catspec(repo.dir, ["accept", "auth-service"]);
      expect(accept.code).toBe(0);
      expect(accept.stdout).toContain(`accepted the current shapes of auth-service`);
      const after = await catspec(repo.dir, ["check"]);
      expect(after.stdout).not.toContain("CS0300");
      expect(after.code).toBe(0);
    });
  });

  it("[AC-hook-installer-1] install-hooks refuses to overwrite a foreign pre-commit hook and explains how to chain it", async () => {
    await withRepo(async (repo) => {
      const hook = join(repo.dir, ".git", "hooks", "pre-commit");
      await mkdir(join(hook, ".."), { recursive: true });
      await writeFile(hook, "#!/bin/sh\necho mine\n", "utf8");
      const { code, stderr } = await catspec(repo.dir, ["install-hooks"]);
      expect(code).toBe(1);
      expect(stderr).toContain(
        "refused: .git/hooks/pre-commit exists and wasn't installed by CatSpec",
      );
      expect(stderr).toContain("npx --no-install catspec check --staged");
      expect(stderr).toContain("--force");
      expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
    });
  });

  it("[AC-hook-installer-2] uninstall-hooks restores the hook replaced with --force byte for byte", async () => {
    await withRepo(async (repo) => {
      const hook = join(repo.dir, ".git", "hooks", "pre-commit");
      const original = "#!/bin/sh\r\n# mine, with CRLF and no final newline\r\necho mine";
      await mkdir(join(hook, ".."), { recursive: true });
      await writeFile(hook, original, "utf8");
      await chmod(hook, 0o755);
      const mode = (await stat(hook)).mode;

      expect((await catspec(repo.dir, ["install-hooks", "--force"])).code).toBe(0);
      const installed = await readFile(hook, "utf8");
      expect(installed).toContain("catspec-managed");
      expect(installed).toContain("pre-commit.catspec-backup");

      const uninstall = await catspec(repo.dir, ["uninstall-hooks"]);
      expect(uninstall.code).toBe(0);
      expect(uninstall.stdout).toContain("restored the previous .git/hooks/pre-commit");
      expect(await readFile(hook, "utf8")).toBe(original);
      expect((await stat(hook)).mode).toBe(mode);
      expect(existsSync(join(repo.dir, ".git", "hooks", "pre-commit.catspec-backup"))).toBe(false);
    });
  });
});

describe("hook installer and staged check details", { timeout: HOOK_TIMEOUT }, () => {
  it("chains a hook kept with --force: both run on commit", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "implemented", authCode(LOGIN));
      const hook = join(repo.dir, ".git", "hooks", "pre-commit");
      await mkdir(join(hook, ".."), { recursive: true });
      await writeFile(hook, "#!/bin/sh\necho ran > chained.txt\n", "utf8");
      await chmod(hook, 0o755);
      expect((await catspec(repo.dir, ["install-hooks", "--force"])).code).toBe(0);
      repo.git("add", "docs", "src");
      const commit = repo.commit("chained");
      expect(commit.code, commit.output).toBe(0);
      expect(existsSync(join(repo.dir, "chained.txt"))).toBe(true);
      expect(repo.git("show", "--name-only", "--format=", "HEAD")).toContain(AUTH_LOCK);
    });
  });

  it("adds and removes a lefthook command, keeping the rest of lefthook.yml", async () => {
    await withRepo(async (repo) => {
      const config = "# team hooks\npre-commit:\n  commands:\n    lint:\n      run: npm run lint\n";
      await repo.write({ "lefthook.yml": config });
      const install = await catspec(repo.dir, ["install-hooks"]);
      expect(install.code, install.stderr).toBe(0);
      expect(install.stdout).toContain("lefthook install");
      const text = await readFile(join(repo.dir, "lefthook.yml"), "utf8");
      expect(text).toContain("# team hooks");
      expect(text).toContain("run: npm run lint");
      expect(text).toContain("catspec check --staged");
      expect((await catspec(repo.dir, ["install-hooks"])).stdout).toContain("already runs CatSpec");
      expect((await catspec(repo.dir, ["uninstall-hooks"])).code).toBe(0);
      expect(await readFile(join(repo.dir, "lefthook.yml"), "utf8")).toBe(config);
    });
  });

  it("a git whose cat-file process died starts a new one on the next read", async () => {
    await withRepo(async (repo) => {
      await repo.write({ "a.ts": "export const a = 1;\n" });
      repo.git("add", "a.ts");
      const git = new Git(repo.dir);
      try {
        const index = new IndexProvider(git);
        expect((await index.read("a.ts"))?.toString("utf8")).toContain("a = 1");
        const batch = (
          git as unknown as { batch: { child: { kill(): void }; close(): Promise<void> } }
        ).batch;
        batch.child.kill();
        await batch.close();
        expect((await index.read("a.ts"))?.toString("utf8")).toContain("a = 1");
      } finally {
        await git.close();
      }
    });
  });

  it("CATSPEC_SKIP=1 skips the staged check, and the next run warns about it", async () => {
    await withRepo(async (repo) => {
      await authRepo(repo, "implemented", authCode(LOGOUT));
      repo.git("add", "docs", "src");
      const skipped = await catspec(repo.dir, ["check", "--staged"], { CATSPEC_SKIP: "1" });
      expect(skipped.code).toBe(0);
      expect(skipped.stderr).toContain("CATSPEC_SKIP=1");
      const next = await catspec(repo.dir, ["check", "--staged"]);
      expect(next.code).toBe(1);
      expect(next.stderr).toContain("an earlier commit skipped the CatSpec check");
      expect((await catspec(repo.dir, ["check", "--staged"])).stderr).not.toContain("skipped");
    });
  });

  it("init --hooks creates the layout and installs the hook", async () => {
    await withRepo(async (repo) => {
      const { code, stdout } = await catspec(repo.dir, ["init", "--hooks"]);
      expect(code).toBe(0);
      expect(stdout).toContain("installed .git/hooks/pre-commit");
      expect(await readFile(join(repo.dir, ".git", "hooks", "pre-commit"), "utf8")).toContain(
        "catspec check --staged",
      );
    });
  });

  it("check --staged outside a git repository is a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catspec-plain-"));
    try {
      const { code, stderr } = await catspec(dir, ["check", "--staged"]);
      expect(code).toBe(2);
      expect(stderr).toContain("--staged needs a git repository");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a commit that leaves out the not yet staged ADR log isn't blocked: CS0107 is a warning", async () => {
    await withRepo(
      async (repo) => {
        repo.git("add", "--", "src.ts");
        const { code, stdout } = await catspec(repo.dir, ["check", "--staged"]);
        expect(code, stdout).toBe(0);
        expect(stdout).toContain("CS0107");
        expect(stdout).toContain(`git add ${ADR_LOG}`);

        // Without the log anywhere, it is still an error.
        await rm(join(repo.dir, ADR_LOG));
        expect((await catspec(repo.dir, ["check", "--staged"])).code).toBe(1);
      },
      {
        "catspec.yaml": "version: 1\n",
        [ADR_LOG]: adrLogText(),
        "src.ts": "export const one = 1;\n",
      },
    );
  });
});
