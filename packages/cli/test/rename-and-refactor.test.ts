/**
 * Feature F6 `rename-and-refactor` end to end: rename detection, `catspec sync`, `catspec bind`,
 * batch rename mapping and refactor mode, on real git repositories (PBIs `rename-detection`,
 * `sync-command`, `bind-command`, `batch-rename-mapping`, `refactor-mode`).
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig, parseSpecSource, readYaml, Git, type Diagnostic } from "@catspec/core";
import { describe, expect, it } from "vitest";

import { ADR_LOG, adrLogText, specText, withRepo, type GitRepo } from "../../../test/temp-repo.js";
import { formatDiff } from "../src/diff.js";
import { run } from "../src/index.js";
import { PLAIN } from "../src/report.js";
import { planRepositorySync, readRefactor } from "../src/sync.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const posix = (path: string): string => path.replace(/\\/g, "/");
/** The `catspec` bin entry run from source (the monorepo test rebuilds `dist/` meanwhile). */
const BIN_ARGS = [
  "--conditions=source",
  "--import",
  pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
  posix(join(repoRoot, "packages", "cli", "src", "bin.ts")),
];

async function catspec(
  cwd: string,
  args: string[],
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

/** `catspec --format json …` parsed. */
async function catspecJson<T>(cwd: string, args: string[]): Promise<{ code: number; json: T }> {
  const result = await catspec(cwd, [...args, "--format", "json"]);
  return { code: result.code, json: JSON.parse(result.stdout) as T };
}

/** The CLI as `node_modules/.bin/catspec`, which the installed hook runs. */
async function installHook(repo: GitRepo): Promise<void> {
  const shim = join(repo.dir, "node_modules", ".bin", "catspec");
  await mkdir(join(shim, ".."), { recursive: true });
  await writeFile(
    shim,
    `#!/bin/sh\nexec node ${BIN_ARGS.map((a) => `"${a}"`).join(" ")} "$@"\n`,
    "utf8",
  );
  await chmod(shim, 0o755);
  await writeFile(join(repo.dir, ".git", "info", "exclude"), "node_modules/\n", "utf8");
  expect((await catspec(repo.dir, ["install-hooks"])).code).toBe(0);
}

/** Real commits run the hook, which starts the CLI through the TypeScript loader each time. */
const HOOK_TIMEOUT = 120_000;

interface Lock {
  satisfied: string[];
  symbols: Record<string, { resolved: string; shape: { name: string } }>;
}
const readLock = async (dir: string, path: string): Promise<Lock> =>
  JSON.parse(await readFile(join(dir, path), "utf8")) as Lock;
const read = (dir: string, path: string): Promise<string> => readFile(join(dir, path), "utf8");

/** Commits everything with lock files from `baseline --rebuild`, without the hook. */
async function commitBaseline(repo: GitRepo, message = "baseline"): Promise<void> {
  const baseline = await catspec(repo.dir, ["baseline", "--rebuild"]);
  expect(baseline.code, baseline.stderr).toBe(0);
  repo.git("add", "-A");
  repo.git("commit", "-q", "--no-verify", "-m", message);
}

/** A spec with the given bindings (YAML list items, each starting with `- `). */
const spec = (id: string, status: string, bindings: string[], body?: string): string =>
  specText(id, {
    status,
    extra: `bindings:\n${bindings.map((b) => `  ${b.replace(/\n/g, "\n  ")}`).join("\n")}\n`,
    ...(body !== undefined ? { body } : {}),
  });

const binding = (id: string, symbol: string, extra = ""): string =>
  `- id: ${id}\n  symbol: ${symbol}\n  kind: class${extra}`;

const USER_HANDLER = (name: string): string => `export class ${name} {
  handle(id: string): boolean {
    const trimmed = id.trim();
    return trimmed.length > 0 && trimmed !== "none";
  }

  close(reason: string): void {
    console.info("closing", reason);
  }
}
`;

describe("F6 rename-and-refactor", { timeout: HOOK_TIMEOUT }, () => {
  it("[AC-F6-1] a renamed class is healed: the hook fails with CS0210 and the patch, sync --apply fixes the spec (spec AC-2)", async () => {
    await withRepo(async (repo) => {
      await repo.write({
        [ADR_LOG]: adrLogText(),
        "docs/spec/users/user-handler.spec.md": spec(
          "user-handler",
          "implemented",
          [binding("handler", "UserHandler", "\n  members: [handle, close]")],
          "# User handler\n\nThe `UserHandler` handles users.\n",
        ),
        "src/users/handler.ts": USER_HANDLER("UserHandler"),
      });
      await commitBaseline(repo);
      await installHook(repo);
      const satisfied = (await readLock(repo.dir, "docs/spec/users/user-handler.lock.json"))
        .satisfied;

      await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
      repo.git("add", "src");
      const blocked = repo.commit("rename the handler");
      expect(blocked.code, blocked.output).not.toBe(0);
      expect(blocked.output).toContain("CS0210");
      expect(blocked.output).toContain("UserHandler is now UserUpdatedHandler");
      expect(blocked.output).toMatch(/^-\s+symbol: UserHandler$/m);
      expect(blocked.output).toMatch(/^\+\s+symbol: UserUpdatedHandler$/m);

      const sync = await catspec(repo.dir, ["sync", "--apply"]);
      expect(sync.code, sync.stdout + sync.stderr).toBe(0);
      const specFile = await read(repo.dir, "docs/spec/users/user-handler.spec.md");
      expect(specFile).toContain("symbol: UserUpdatedHandler");
      // The body mention is reported, not rewritten (no --update-mentions).
      expect(specFile).toContain("The `UserHandler` handles users.");
      expect(sync.stdout).toContain("the body mentions `UserHandler`");

      const passing = repo.commit("rename the handler");
      expect(passing.code, passing.output).toBe(0);
      expect(passing.output).not.toContain("CS0300");
      const lock = await readLock(repo.dir, "docs/spec/users/user-handler.lock.json");
      expect(lock.symbols.handler!.resolved).toBe("src/users/handler.ts#UserUpdatedHandler");
      expect(lock.satisfied).toEqual(satisfied);
    });
  });

  it("[AC-F6-2] a moved file needs nothing: check passes with no edits (spec AC-3)", async () => {
    await withRepo(async (repo) => {
      await repo.write({
        [ADR_LOG]: adrLogText(),
        "docs/spec/auth/auth-service.spec.md": spec("auth-service", "implemented", [
          binding("auth", "AuthService", "\n  members: [login]"),
        ]),
        "src/AuthService.ts":
          "export class AuthService {\n  login(user: string): boolean {\n    return user.length > 0;\n  }\n}\n",
      });
      await commitBaseline(repo);
      const before = await read(repo.dir, "docs/spec/auth/auth-service.spec.md");
      await gitMove(repo, "src/AuthService.ts", "src/services/AuthService.ts");

      const check = await catspec(repo.dir, ["check"]);
      expect(check.code, check.stdout).toBe(0);
      expect(check.stdout).toContain("0 errors, 0 warnings");
      const staged = await catspec(repo.dir, ["check", "--staged"]);
      expect(staged.code, staged.stdout).toBe(0);
      const sync = await catspec(repo.dir, ["sync"]);
      expect(sync.code).toBe(0);
      expect(sync.stdout).toContain("every binding resolves; nothing to sync");
      expect(await read(repo.dir, "docs/spec/auth/auth-service.spec.md")).toBe(before);
    });
  });

  it("[AC-F6-3] a namespace renamed across 40 classes and a moved folder is one CS0215, mapped in one sync (spec AC-11)", async () => {
    await withRepo(async (repo) => {
      await repo.write({ [ADR_LOG]: adrLogText(), ...identityRepo() });
      await commitBaseline(repo);
      await installHook(repo);
      const satisfiedBefore = await satisfiedOf(repo.dir);

      renameIdentityToAccounts(repo, { moveFolder: true });
      await repo.write(accountsSources());
      repo.git("add", "-A");
      const blocked = repo.commit("rename Identity to Accounts");
      expect(blocked.code, blocked.output).not.toBe(0);
      expect(blocked.output.match(/CS0215/g)).toHaveLength(1);
      expect(blocked.output).toContain("40 bindings unresolved in 4 specs");
      expect(blocked.output).not.toContain("CS0201");

      const sync = await catspecJson<{
        mapped: { to: string }[];
        ambiguous: unknown[];
        lost: unknown[];
      }>(repo.dir, ["sync", "--apply"]);
      expect(sync.code).toBe(0);
      expect(sync.json.mapped).toHaveLength(40);
      expect(sync.json.ambiguous).toHaveLength(0);
      expect(sync.json.lost).toHaveLength(0);
      for (const n of [0, 1, 2, 3]) {
        const text = await read(repo.dir, `docs/spec/identity/handlers-${n}.spec.md`);
        expect(text).not.toContain("symbol: Identity.");
        expect(text).toContain(`symbol: Accounts.Handlers.Handler${n * 10}`);
        expect(text).toContain("file: src/Accounts/Handlers/*.cs");
      }
      expect(await satisfiedOf(repo.dir)).toEqual(satisfiedBefore);

      const passing = repo.commit("rename Identity to Accounts");
      expect(passing.code, passing.output).toBe(0);
      expect(passing.output).not.toContain("CS03");
    });
  });

  it("[AC-F6-4] ambiguous renames are never guessed: CS0216 lists the candidates, a rename map resolves them (spec AC-12)", async () => {
    await withRepo(async (repo) => {
      await twinHandlers(repo);
      const before = await read(repo.dir, "docs/spec/events/event-handlers.spec.md");
      await repo.write({
        "src/events/handlers.ts": twinSource("UserCreatedHandler", "UserUpdatedHandler"),
      });

      const sync = await catspec(repo.dir, ["sync", "--apply"]);
      expect(sync.code).toBe(1);
      expect(sync.stdout.match(/CS0216/g)).toHaveLength(2);
      expect(sync.stdout).toContain("UserCreatedHandler (src/events/handlers.ts:");
      expect(sync.stdout).toContain("UserUpdatedHandler (src/events/handlers.ts:");
      expect(sync.stdout).toContain("nothing written");
      expect(await read(repo.dir, "docs/spec/events/event-handlers.spec.md")).toBe(before);

      await repo.write({
        "renames.json": JSON.stringify({
          symbols: { CreatedHandler: "UserCreatedHandler", UpdatedHandler: "UserUpdatedHandler" },
        }),
      });
      const mapped = await catspec(repo.dir, ["sync", "--apply", "--map", "renames.json"]);
      expect(mapped.code, mapped.stdout).toBe(0);
      const text = await read(repo.dir, "docs/spec/events/event-handlers.spec.md");
      expect(text).toContain("symbol: UserCreatedHandler");
      expect(text).toContain("symbol: UserUpdatedHandler");
      expect((await catspec(repo.dir, ["check"])).code).toBe(0);
    });
  });

  describe("rename-detection", () => {
    const cases: [string, (repo: GitRepo) => Promise<void>, (r: Outcome) => void][] = [
      [
        "class renamed, same members → renamed, score ≥ 0.8",
        async (repo) => {
          await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
        },
        (r) => {
          expect(r.mapped).toHaveLength(1);
          expect(r.mapped[0]!.to).toBe("src/users/handler.ts#UserUpdatedHandler");
          expect(r.mapped[0]!.score).toBeGreaterThanOrEqual(0.8);
        },
      ],
      [
        "class renamed and moved to a renamed file → renamed",
        async (repo) => {
          await gitMove(repo, "src/users/handler.ts", "src/accounts/account-handler.ts");
          await repo.write({ "src/accounts/account-handler.ts": USER_HANDLER("AccountHandler") });
          repo.git("add", "-A");
        },
        (r) => {
          expect(r.mapped).toHaveLength(1);
          expect(r.mapped[0]!.to).toBe("src/accounts/account-handler.ts#AccountHandler");
        },
      ],
      [
        "two similar classes renamed → ambiguous",
        async (repo) => {
          await repo.write({
            "src/users/handler.ts":
              USER_HANDLER("AccountHandler") + "\n" + USER_HANDLER("CustomerHandler"),
          });
        },
        (r) => {
          expect(r.mapped).toHaveLength(0);
          expect(r.ambiguous).toHaveLength(1);
          expect(r.ambiguous[0]!.candidates).toHaveLength(2);
        },
      ],
      [
        "class renamed and its body rewritten → below threshold, none",
        async (repo) => {
          await repo.write({
            "src/users/handler.ts":
              "export class UserProcessor {\n  run(input: number): number {\n    return input * 2;\n  }\n\n  stop(): void {}\n}\n",
          });
        },
        (r) => {
          expect(r.mapped).toHaveLength(0);
          expect(r.ambiguous).toHaveLength(0);
          expect(r.lost).toHaveLength(1);
        },
      ],
    ];
    it.each(cases)("[AC-rename-detection-1] %s", async (_name, change, expectation) => {
      await withRepo(async (repo) => {
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/users/user-handler.spec.md": spec("user-handler", "implemented", [
            binding("handler", "UserHandler", "\n  members: [handle, close]"),
          ]),
          "src/users/handler.ts": USER_HANDLER("UserHandler"),
        });
        await commitBaseline(repo);
        await change(repo);
        expectation((await catspecJson<Outcome>(repo.dir, ["sync"])).json);
      });
    });
  });

  describe("sync-command", () => {
    it("[AC-sync-command-1] a dry run prints a diff and changes no file", async () => {
      await withRepo(async (repo) => {
        await userHandlerRepo(repo);
        await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
        const status = repo.git("status", "--porcelain");
        const before = await read(repo.dir, "docs/spec/users/user-handler.spec.md");
        const lock = await read(repo.dir, "docs/spec/users/user-handler.lock.json");

        const sync = await catspec(repo.dir, ["sync"]);
        expect(sync.code).toBe(0);
        expect(sync.stdout).toContain("--- a/docs/spec/users/user-handler.spec.md");
        expect(sync.stdout).toMatch(/^-\s+symbol: UserHandler$/m);
        expect(sync.stdout).toMatch(/^\+\s+symbol: UserUpdatedHandler$/m);
        expect(sync.stdout).toContain("dry run: no file was changed");
        expect(await read(repo.dir, "docs/spec/users/user-handler.spec.md")).toBe(before);
        expect(await read(repo.dir, "docs/spec/users/user-handler.lock.json")).toBe(lock);
        expect(repo.git("status", "--porcelain")).toBe(status);
      });
    });

    const renames: [string, string, string[]][] = [
      ["same members", USER_HANDLER("UserUpdatedHandler"), []],
      [
        "a member added, named in a rename map",
        USER_HANDLER("UserUpdatedHandler").replace(
          "  close(",
          '  reopen(reason: string): void {\n    console.info("reopening", reason);\n  }\n\n  close(',
        ),
        ["--map", "renames.json"],
      ],
      [
        "a parameter type changed",
        USER_HANDLER("UserUpdatedHandler")
          .replace("handle(id: string)", "handle(id: number)")
          .replace("id.trim()", "String(id).trim()"),
        [],
      ],
    ];
    it.each(renames)(
      "[AC-sync-command-2] automatic edits change only symbol and file values (%s)",
      async (_name, code, args) => {
        await withRepo(async (repo) => {
          await userHandlerRepo(repo, {
            hint: "\n  file: src/users/handler.ts",
            members:
              "\n  members:\n    - { name: handle, kind: method, params: [string], returns: boolean }\n    - close",
            implementsLine: "\n  exported: true",
          });
          repo.git("mv", "src/users/handler.ts", "src/users/updated-handler.ts");
          await repo.write({ "src/users/updated-handler.ts": code });
          await repo.write({
            "renames.json": '{ "symbols": { "UserHandler": "UserUpdatedHandler" } }',
          });
          repo.git("add", "-A");
          const before = parseFrontmatter(
            await read(repo.dir, "docs/spec/users/user-handler.spec.md"),
          );

          const sync = await catspec(repo.dir, ["sync", "--apply", ...args]);
          expect(sync.code, sync.stdout).toBe(0);
          const after = parseFrontmatter(
            await read(repo.dir, "docs/spec/users/user-handler.spec.md"),
          );
          const binding = (after.bindings as Record<string, unknown>[])[0]!;
          expect(binding.symbol).toBe("UserUpdatedHandler");
          expect(binding.file).toBe("src/users/updated-handler.ts");
          // Everything else is exactly as declared.
          const strip = (fm: Record<string, unknown>): unknown => ({
            ...fm,
            bindings: (fm.bindings as Record<string, unknown>[]).map((b) =>
              Object.fromEntries(
                Object.entries(b).filter(([key]) => key !== "symbol" && key !== "file"),
              ),
            ),
          });
          expect(strip(after)).toEqual(strip(before));
        });
      },
    );

    it("--update-mentions rewrites backticked mentions in the body", async () => {
      await withRepo(async (repo) => {
        await userHandlerRepo(repo, {
          body: "# Users\n\n- `UserHandler.handle` trims ids; `UserHandlerFactory` is unrelated.\n\n```ts\nnew UserHandler();\n```\n",
        });
        await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
        const sync = await catspec(repo.dir, ["sync", "--apply", "--update-mentions"]);
        expect(sync.code, sync.stdout).toBe(0);
        const text = await read(repo.dir, "docs/spec/users/user-handler.spec.md");
        expect(text).toContain(
          "`UserUpdatedHandler.handle` trims ids; `UserHandlerFactory` is unrelated.",
        );
        expect(text).toContain("new UserHandler();");
      });
    });

    it("heal.mode auto: the hook applies the patch, stages the spec and lets the commit through", async () => {
      await withRepo(async (repo) => {
        await repo.write({ "catspec.yaml": "version: 1\nheal:\n  mode: auto\n" });
        await userHandlerRepo(repo);
        await installHook(repo);
        await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
        repo.git("add", "src");
        const commit = repo.commit("rename");
        expect(commit.code, commit.output).toBe(0);
        expect(commit.output).toContain("heal.mode auto: updated and staged");
        const committed = repo.git("show", "HEAD:docs/spec/users/user-handler.spec.md");
        expect(committed).toContain("symbol: UserUpdatedHandler");
        expect(repo.git("status", "--porcelain").trim()).toBe("");
      });
    });

    it("a spec with unstaged changes is not staged by sync --apply", async () => {
      await withRepo(async (repo) => {
        await userHandlerRepo(repo);
        await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
        const file = "docs/spec/users/user-handler.spec.md";
        await repo.write({ [file]: (await read(repo.dir, file)) + "\nA note.\n" });
        const sync = await catspec(repo.dir, ["sync", "--apply"]);
        expect(sync.code, sync.stdout).toBe(0);
        expect(sync.stdout).toContain(`not staged (unstaged changes): ${file}`);
        expect(repo.git("diff", "--cached", "--name-only")).not.toContain(file);
        expect(await read(repo.dir, file)).toContain("A note.");
      });
    });

    it("rejects an invalid rename map", async () => {
      await withRepo(async (repo) => {
        await userHandlerRepo(repo);
        await repo.write({ "renames.json": '{ "symbol": { "A": "B" } }' });
        const sync = await catspec(repo.dir, ["sync", "--map", "renames.json"]);
        expect(sync.code).toBe(2);
        expect(sync.stderr).toContain('unknown key "symbol"');
      });
    });
  });

  describe("bind-command", () => {
    it("[AC-bind-command-1] a new binding passes immediately", async () => {
      await withRepo(async (repo) => {
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/auth/auth.spec.md": specText("auth", {
            status: "in-progress",
            body: "# Auth\n",
          }),
          "src/auth/AuthService.ts": `import type { Store } from "./store";

export class AuthService {
  constructor(private readonly store: Store) {}

  async login(user: string, password: string): Promise<boolean> {
    return this.store.check(user, password);
  }

  logout(user: string): void {
    this.store.forget(user);
  }

  get current(): string | undefined {
    return this.store.user;
  }

  private audit(): void {}
}
`,
          "src/auth/store.ts":
            "export interface Store {\n  user?: string;\n  check(u: string, p: string): Promise<boolean>;\n  forget(u: string): void;\n}\n",
        });
        const bind = await catspec(repo.dir, ["bind", "AuthService", "--spec", "auth"]);
        expect(bind.code, bind.stdout + bind.stderr).toBe(0);
        const fm = parseFrontmatter(await read(repo.dir, "docs/spec/auth/auth.spec.md"));
        const bound = (fm.bindings as Record<string, unknown>[])[0]!;
        expect(bound).toMatchObject({
          id: "AuthService",
          symbol: "AuthService",
          kind: "class",
          exported: true,
        });
        expect((bound.members as { name: string }[]).map((m) => m.name)).toEqual([
          "login",
          "logout",
          "current",
        ]);
        expect(bound.constructor).toEqual({ requires: ["Store"] });

        const check = await catspec(repo.dir, ["check", "--spec", "auth"]);
        expect(check.code, check.stdout).toBe(0);
        expect(check.stdout.trimEnd().split("\n").at(-1)).toBe("DONE");
      });
    });

    it("reports a symbol that isn't found or is ambiguous, and writes nothing", async () => {
      await withRepo(async (repo) => {
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/auth/auth.spec.md": specText("auth", { status: "draft" }),
          "src/a.ts": "export class Service {}\n",
          "src/b.ts": "export class Service {}\n",
        });
        const before = await read(repo.dir, "docs/spec/auth/auth.spec.md");
        const missing = await catspec(repo.dir, ["bind", "Servise", "--spec", "auth"]);
        expect(missing.code).toBe(1);
        expect(missing.stdout).toContain("CS0201");
        const twice = await catspec(repo.dir, ["bind", "Service", "--spec", "auth"]);
        expect(twice.code).toBe(1);
        expect(twice.stdout).toContain("CS0202");
        expect(await read(repo.dir, "docs/spec/auth/auth.spec.md")).toBe(before);
        const one = await catspec(repo.dir, [
          "bind",
          "Service",
          "--spec",
          "auth",
          "--file",
          "src/b.ts",
        ]);
        expect(one.code, one.stdout).toBe(0);
        expect(await read(repo.dir, "docs/spec/auth/auth.spec.md")).toContain("file: src/b.ts");
      });
    });
  });

  describe("batch-rename-mapping", () => {
    it("[AC-batch-rename-mapping-1] 40 classes renamed from Identity.* to Accounts.* are mapped by the prefix rule and keep their satisfied items", async () => {
      await withRepo(async (repo) => {
        await repo.write({ [ADR_LOG]: adrLogText(), ...identityRepo() });
        await commitBaseline(repo);
        const satisfiedBefore = await satisfiedOf(repo.dir);
        await repo.write(identitySources("Accounts"));

        const sync = await catspecJson<{ mapped: { evidence: string; detail?: string }[] }>(
          repo.dir,
          ["sync", "--apply"],
        );
        expect(sync.code).toBe(0);
        expect(sync.json.mapped).toHaveLength(40);
        expect(new Set(sync.json.mapped.map((m) => m.evidence))).toEqual(new Set(["prefix"]));
        expect(sync.json.mapped[0]!.detail).toBe("namespace Identity → Accounts");
        expect(await satisfiedOf(repo.dir)).toEqual(satisfiedBefore);
        const lock = await readLock(repo.dir, "docs/spec/identity/handlers-0.lock.json");
        expect(lock.symbols.h0!.resolved).toBe(
          "src/Identity/Handlers/Handler0.cs#Accounts.Handlers.Handler0",
        );
        expect((await catspec(repo.dir, ["check"])).code).toBe(0);
      });
    });

    it("[AC-batch-rename-mapping-2] one new class is never used twice", async () => {
      await withRepo(async (repo) => {
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/users/users.spec.md": spec("users", "implemented", [
            binding("first", "FirstHandler"),
            binding("second", "SecondHandler"),
          ]),
          "src/users/handlers.ts":
            USER_HANDLER("FirstHandler") + "\n" + USER_HANDLER("SecondHandler"),
        });
        await commitBaseline(repo);
        await repo.write({ "src/users/handlers.ts": USER_HANDLER("MergedHandler") });

        const { json } = await catspecJson<Outcome>(repo.dir, ["sync"]);
        const toMerged = json.mapped.filter((m) => m.to.endsWith("#MergedHandler"));
        expect(toMerged.length).toBeLessThanOrEqual(1);
        expect(json.mapped.length + json.ambiguous.length + json.lost.length).toBe(2);
        const first = await withMap(repo, {
          symbols: { FirstHandler: "MergedHandler", SecondHandler: "MergedHandler" },
        });
        // Even an explicit map can't send two bindings to one class.
        expect(first.mapped).toHaveLength(0);
        expect(first.ambiguous).toHaveLength(2);
      });
    });

    it("[AC-batch-rename-mapping-3] a deleted class blocks sync --apply during a refactor with CS0217, and the refactor stays open", async () => {
      await withRepo(async (repo) => {
        await accountRepo(repo);
        expect((await catspec(repo.dir, ["refactor", "--scope", "src/accounts/**"])).code).toBe(0);
        await repo.write({
          "src/accounts/services.ts":
            accountService("AccountsService") + accountService("BillingService"),
        });
        const before = await read(repo.dir, "docs/spec/accounts/accounts.spec.md");

        const sync = await catspec(repo.dir, ["sync", "--apply"]);
        expect(sync.code).toBe(1);
        expect(sync.stdout).toContain("CS0217");
        expect(sync.stdout).toContain("AuditService is gone and nothing replaces it");
        expect(sync.stdout).toContain("the refactor stays open");
        expect(await read(repo.dir, "docs/spec/accounts/accounts.spec.md")).toBe(before);
        const git = new Git(repo.dir);
        expect(await readRefactor(git)).toBeDefined();

        const partial = await catspec(repo.dir, ["sync", "--apply", "--partial"]);
        expect(partial.code).toBe(1);
        expect(await read(repo.dir, "docs/spec/accounts/accounts.spec.md")).toContain(
          "symbol: AccountsService",
        );
        expect(await readRefactor(git)).toBeDefined();
        await git.close();
      });
    });
  });

  describe("refactor-mode", () => {
    it("[AC-refactor-mode-1] with --allow-wip, broken commits go through on the refactor's branch with one CS0215 warning, and are blocked elsewhere", async () => {
      await withRepo(async (repo) => {
        await accountRepo(repo);
        await installHook(repo);
        repo.git("checkout", "-q", "-b", "rename-accounts");
        const start = await catspec(repo.dir, [
          "refactor",
          "--scope",
          "src/accounts/**",
          "--allow-wip",
          "--reason",
          "rename accounts",
        ]);
        expect(start.code, start.stderr).toBe(0);
        expect(start.stdout).toContain("refactor started on rename-accounts");

        const steps: [string, string][] = [
          ["AccountService", "AccountsService"],
          ["BillingService", "InvoicingService"],
          ["AuditService", "AuditTrailService"],
        ];
        let source = await read(repo.dir, "src/accounts/services.ts");
        for (const [from, to] of steps) {
          source = source.replaceAll(from, to);
          await repo.write({ "src/accounts/services.ts": source });
          repo.git("add", "src");
          const commit = repo.commit(`wip: ${to}`);
          expect(commit.code, commit.output).toBe(0);
          expect(commit.output.match(/CS0215/g)).toHaveLength(1);
          expect(commit.output).toContain("refactor in progress (rename accounts)");
          expect(commit.output).toContain("work in progress allowed on rename-accounts");
          expect(commit.output).not.toContain("CS0201");
        }

        repo.git("checkout", "-q", "-b", "elsewhere");
        await repo.write({
          "src/accounts/services.ts": source.replace("InvoicingService", "PaymentsService"),
        });
        repo.git("add", "src");
        const blocked = repo.commit("breaks on another branch");
        expect(blocked.code, blocked.output).not.toBe(0);
        expect(blocked.output.match(/CS0215/g)).toHaveLength(1);
        expect(blocked.output).toContain("work in progress is allowed only on rename-accounts");

        // Back on the refactor's branch, sync maps everything against the baseline and ends it.
        repo.git("checkout", "-q", "-f", "rename-accounts");
        const status = await catspecJson<{ broken: number; mapped: number }>(repo.dir, [
          "refactor",
          "status",
        ]);
        expect(status.json).toMatchObject({ broken: 3, mapped: 3 });
        const sync = await catspec(repo.dir, ["sync", "--apply"]);
        expect(sync.code, sync.stdout).toBe(0);
        expect(sync.stdout).toContain("the refactor is finished");
        const git = new Git(repo.dir);
        expect(await readRefactor(git)).toBeUndefined();
        await git.close();
        const done = repo.commit("finish the refactor");
        expect(done.code, done.output).toBe(0);
        expect(done.output).not.toContain("CS02");
      });
    });

    it("[AC-refactor-mode-2] abort deletes the baseline and changes no spec", async () => {
      await withRepo(async (repo) => {
        await accountRepo(repo);
        expect((await catspec(repo.dir, ["refactor"])).code).toBe(0);
        const git = new Git(repo.dir);
        const baseline = await readRefactor(git);
        expect(baseline?.symbols).toHaveLength(3);
        const store = join((await git.repository()).commonDir, "catspec", "refactor.json");
        expect(existsSync(store)).toBe(true);
        await repo.write({
          "src/accounts/services.ts": (await read(repo.dir, "src/accounts/services.ts")).replaceAll(
            "Account",
            "Customer",
          ),
        });

        const again = await catspec(repo.dir, ["refactor"]);
        expect(again.code).toBe(2);
        expect(again.stderr).toContain("a refactor is already in progress");
        const abort = await catspec(repo.dir, ["refactor", "abort"]);
        expect(abort.code).toBe(0);
        expect(abort.stdout).toContain("refactor aborted");
        expect(existsSync(store)).toBe(false);
        expect(repo.git("status", "--porcelain").trim()).toBe("M src/accounts/services.ts");
        expect((await catspec(repo.dir, ["refactor", "status"])).stdout).toBe(
          "no refactor in progress\n",
        );
        await git.close();
      });
    });
  });

  it("without a refactor, the hook groups more than refactor.detect_threshold broken bindings", async () => {
    await withRepo(async (repo) => {
      await repo.write({ "catspec.yaml": "version: 1\nrefactor:\n  detect_threshold: 2\n" });
      await accountRepo(repo);
      await repo.write({
        "src/accounts/services.ts": (await read(repo.dir, "src/accounts/services.ts")).replaceAll(
          "Service",
          "Manager",
        ),
      });
      repo.git("add", "src");
      const check = await catspec(repo.dir, ["check", "--staged"]);
      expect(check.code).toBe(1);
      expect(check.stdout.match(/CS0215/g)).toHaveLength(1);
      expect(check.stdout).toContain("more than refactor.detect_threshold, 2");
      const { root, config } = await loadConfig(repo.dir);
      const git = new Git(root);
      const plan = await planRepositorySync(root, config, git, { staged: true });
      await git.close();
      expect(plan.plan.report.mapped).toHaveLength(3);
      expect(diagnosticCodes(plan.plan.diagnostics)).toEqual(["CS0210", "CS0210", "CS0210"]);
    });
  });

  describe("review fixes", () => {
    it("a declaration that already existed elsewhere under the same name is not a move", async () => {
      await withRepo(async (repo) => {
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/config/config.spec.md": spec("config", "implemented", [
            binding("config", "src/a#Config", "\n  members: [handle, close]"),
          ]),
          "src/a.ts": USER_HANDLER("Config"),
          "src/b.ts": "export class Config {\n  unrelated(): number {\n    return 1;\n  }\n}\n",
        });
        await commitBaseline(repo);
        await repo.write({ "src/a.ts": USER_HANDLER("AppConfig") });
        const sync = await catspecJson<Outcome>(repo.dir, ["sync"]);
        expect(sync.json.mapped).toHaveLength(1);
        expect(sync.json.mapped[0]!.to).toBe("src/a.ts#AppConfig");
      });
    });

    it("a member-less declaration is not mapped by its fingerprint below heal.threshold", async () => {
      await withRepo(async (repo) => {
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/life/lifecycle.spec.md": spec("lifecycle", "implemented", [
            "- id: init\n  symbol: init\n  kind: function",
          ]),
          "src/lifecycle.ts": "export function init(): void {\n  start(1, 2);\n}\n",
        });
        await commitBaseline(repo);
        await repo.write({
          "src/lifecycle.ts":
            'export function shutdown(): void {\n  console.info("stopping everything now");\n}\n',
        });
        const sync = await catspecJson<Outcome>(repo.dir, ["sync"]);
        expect(sync.json.mapped).toHaveLength(0);
        expect(sync.json.lost).toHaveLength(1);
      });
    });

    it("a C# partial class is one candidate of the prefix rule", async () => {
      await withRepo(async (repo) => {
        const files = (ns: string): Record<string, string> => ({
          "src/User.cs": `namespace ${ns};\n\npublic partial class User\n{\n    public void Rename(string name) { }\n}\n`,
          "src/User.Validation.cs": `namespace ${ns};\n\npublic partial class User\n{\n    public bool Validate() { return true; }\n}\n`,
          "src/Role.cs": `namespace ${ns};\n\npublic class Role\n{\n    public string Title { get; set; }\n}\n`,
        });
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/identity/identity.spec.md": spec("identity", "implemented", [
            binding("user", "Identity.User", "\n  members: [Rename, Validate]"),
            binding("role", "Identity.Role", "\n  members: [Title]"),
          ]),
          ...files("Identity"),
        });
        await commitBaseline(repo);
        await repo.write(files("Accounts"));
        const sync = await catspecJson<Outcome>(repo.dir, ["sync", "--apply"]);
        expect(sync.json.ambiguous).toHaveLength(0);
        expect(sync.json.mapped.map((m) => m.evidence)).toEqual(["prefix", "prefix"]);
        const check = await catspec(repo.dir, ["check"]);
        expect(check.code, check.stdout).toBe(0);
      });
    });

    it("every prefix rule that applies is tried: one namespace split into two", async () => {
      await withRepo(async (repo) => {
        const cls = (ns: string, name: string): string =>
          `namespace ${ns};\n\npublic class ${name}\n{\n    public void Run${name}() { }\n}\n`;
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/identity/identity.spec.md": spec(
            "identity",
            "implemented",
            ["A", "B", "C", "D"].map((n) =>
              binding(n.toLowerCase(), `Identity.${n}`, `\n  members: [Run${n}]`),
            ),
          ),
          ...Object.fromEntries(
            ["A", "B", "C", "D"].map((n) => [`src/${n}.cs`, cls("Identity", n)]),
          ),
        });
        await commitBaseline(repo);
        await repo.write({
          "src/A.cs": cls("Accounts", "A"),
          "src/B.cs": cls("Accounts", "B"),
          "src/C.cs": cls("Users", "C"),
          "src/D.cs": cls("Users", "D"),
        });
        const sync = await catspecJson<Outcome>(repo.dir, ["sync"]);
        expect(sync.json.lost).toHaveLength(0);
        expect(sync.json.mapped.map((m) => [m.to, m.evidence])).toEqual([
          ["src/A.cs#Accounts.A", "prefix"],
          ["src/B.cs#Accounts.B", "prefix"],
          ["src/C.cs#Users.C", "prefix"],
          ["src/D.cs#Users.D", "prefix"],
        ]);
      });
    });

    it("sync --apply stages a CRLF spec under core.autocrlf", async () => {
      await withRepo(async (repo) => {
        await userHandlerRepo(repo);
        repo.git("config", "core.autocrlf", "true");
        const file = "docs/spec/users/user-handler.spec.md";
        const lockFile = "docs/spec/users/user-handler.lock.json";
        for (const f of [file, lockFile]) {
          await repo.write({ [f]: (await read(repo.dir, f)).replace(/\n/g, "\r\n") });
        }
        // Same content as the index once git converts the line endings.
        expect(repo.git("diff", "--name-only").trim()).toBe("");
        await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
        const sync = await catspec(repo.dir, ["sync", "--apply"]);
        expect(sync.code, sync.stdout).toBe(0);
        expect(sync.stdout).not.toContain("not staged");
        expect(repo.git("diff", "--cached", "--name-only")).toContain(file);
      });
    });

    it("--allow-wip never applies on a detached HEAD", async () => {
      await withRepo(async (repo) => {
        await accountRepo(repo);
        repo.git("checkout", "-q", "--detach");
        expect((await catspec(repo.dir, ["refactor", "--allow-wip"])).code).toBe(0);
        const source = await read(repo.dir, "src/accounts/services.ts");
        await repo.write({
          "src/accounts/services.ts": source.replaceAll("AccountService", "AccountsService"),
        });
        repo.git("add", "src");
        const check = await catspec(repo.dir, ["check", "--staged"]);
        expect(check.code, check.stdout).toBe(1);
        expect(check.stdout).toContain("work in progress is allowed only on the branch");
      });
    });

    it("heal.mode auto heals nothing when a rename is ambiguous, and keeps the candidates", async () => {
      await withRepo(async (repo) => {
        await repo.write({ "catspec.yaml": "version: 1\nheal:\n  mode: auto\n" });
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/events/event-handlers.spec.md": spec("event-handlers", "implemented", [
            binding("created", "CreatedHandler", "\n  members: [handle]"),
            binding("updated", "UpdatedHandler", "\n  members: [handle]"),
            binding("user", "UserHandler", "\n  members: [handle, close]"),
          ]),
          "src/events/handlers.ts": twinSource("CreatedHandler", "UpdatedHandler"),
          "src/users/handler.ts": USER_HANDLER("UserHandler"),
        });
        await commitBaseline(repo);
        await repo.write({
          "src/events/handlers.ts": twinSource("AddedHandler", "ChangedHandler"),
          "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler"),
        });
        repo.git("add", "src");
        const check = await catspec(repo.dir, ["check", "--staged"]);
        expect(check.code, check.stdout).toBe(1);
        expect(check.stdout).toContain("CS0216");
        expect(check.stdout).toContain("not healed automatically");
        expect(repo.git("diff", "--cached", "--name-only")).not.toContain("docs/");
        expect(await read(repo.dir, "docs/spec/events/event-handlers.spec.md")).toContain(
          "symbol: UserHandler",
        );
      });
    });

    it("heal.mode auto with hook.stage_generated false writes the spec but doesn't stage it", async () => {
      await withRepo(async (repo) => {
        await repo.write({
          "catspec.yaml": "version: 1\nheal:\n  mode: auto\nhook:\n  stage_generated: false\n",
        });
        await userHandlerRepo(repo);
        await repo.write({ "src/users/handler.ts": USER_HANDLER("UserUpdatedHandler") });
        repo.git("add", "src");
        const check = await catspec(repo.dir, ["check", "--staged"]);
        expect(check.stdout).toContain("did not stage (hook.stage_generated is false)");
        expect(repo.git("diff", "--cached", "--name-only")).not.toContain("docs/");
        expect(await read(repo.dir, "docs/spec/users/user-handler.spec.md")).toContain(
          "symbol: UserUpdatedHandler",
        );
      });
    });

    it("--update-mentions rewrites every renamed name in one mention", async () => {
      await withRepo(async (repo) => {
        await repo.write({
          [ADR_LOG]: adrLogText(),
          "docs/spec/accounts/accounts.spec.md": spec(
            "accounts",
            "implemented",
            [
              binding("account", "AccountService", "\n  members: [open, close]"),
              binding("billing", "BillingService", "\n  members: [open, close]"),
            ],
            "# Accounts\n\nSee `AccountService(BillingService billing)`.\n",
          ),
          "src/accounts/services.ts":
            accountService("AccountService") + accountService("BillingService"),
        });
        await commitBaseline(repo);
        await repo.write({
          "src/accounts/services.ts":
            accountService("AccountService").replaceAll("AccountService", "AccountsService") +
            accountService("BillingService").replaceAll("BillingService", "InvoicingService"),
        });
        const sync = await catspec(repo.dir, ["sync", "--apply", "--update-mentions"]);
        expect(sync.code, sync.stdout).toBe(0);
        expect(await read(repo.dir, "docs/spec/accounts/accounts.spec.md")).toContain(
          "See `AccountsService(InvoicingService billing)`.",
        );
      });
    });

    it("sync --apply --partial ends the refactor when nothing is left", async () => {
      await withRepo(async (repo) => {
        await accountRepo(repo);
        expect((await catspec(repo.dir, ["refactor"])).code).toBe(0);
        const source = await read(repo.dir, "src/accounts/services.ts");
        await repo.write({
          "src/accounts/services.ts": source.replaceAll("AuditService", "AuditTrailService"),
        });
        const sync = await catspec(repo.dir, ["sync", "--apply", "--partial"]);
        expect(sync.code, sync.stdout).toBe(0);
        expect(sync.stdout).toContain("the refactor is finished");
        const git = new Git(repo.dir);
        expect(await readRefactor(git)).toBeUndefined();
        await git.close();
      });
    });

    it("a refactor's sync keeps drift that was never accepted", async () => {
      await withRepo(async (repo) => {
        await userHandlerRepo(repo);
        const lockFile = "docs/spec/users/user-handler.lock.json";
        const accepted = (await readLock(repo.dir, lockFile)).symbols.handler!.shape;
        // Drift at HEAD that nobody accepted: a new member, committed without the hook.
        await repo.write({
          "src/users/handler.ts": USER_HANDLER("UserHandler").replace(
            "\n}\n",
            "\n  extra(): void {}\n}\n",
          ),
        });
        repo.git("add", "src");
        repo.git("commit", "-q", "--no-verify", "-m", "drift");
        expect((await catspec(repo.dir, ["refactor"])).code).toBe(0);
        await repo.write({
          "src/users/handler.ts": (await read(repo.dir, "src/users/handler.ts")).replace(
            "class UserHandler",
            "class UserUpdatedHandler",
          ),
        });
        const sync = await catspec(repo.dir, ["sync", "--apply"]);
        expect(sync.code, sync.stdout).toBe(0);
        const lock = await readLock(repo.dir, lockFile);
        expect(lock.symbols.handler!.resolved).toBe("src/users/handler.ts#UserUpdatedHandler");
        expect(lock.symbols.handler!.shape).toEqual(accepted);
        expect((await catspec(repo.dir, ["check"])).stdout).toContain("CS0300");
      });
    });

    it("the diff of a long file shows the changed line with its line number", () => {
      const before = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
      const after = before.replace("line 2500\n", "line 2500 changed\n");
      expect(formatDiff("a.md", before, after, PLAIN)).toBe(
        "--- a/a.md\n+++ b/a.md\n@@ line 2499 @@\n line 2499\n-line 2500\n+line 2500 changed\n line 2501\n",
      );
    });
  });
});

/** `git mv` into a folder that may not exist yet. */
async function gitMove(repo: GitRepo, from: string, to: string): Promise<void> {
  await mkdir(join(repo.dir, to, ".."), { recursive: true });
  repo.git("mv", from, to);
}

interface Outcome {
  mapped: { spec: string; binding: string; to: string; evidence: string; score?: number }[];
  ambiguous: { candidates: unknown[] }[];
  lost: unknown[];
}

const diagnosticCodes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => d.code);

function parseFrontmatter(text: string): Record<string, unknown> {
  const parsed = parseSpecSource(text, "spec.spec.md");
  return readYaml(parsed.source!.frontmatter.text, []) as Record<string, unknown>;
}

async function satisfiedOf(dir: string): Promise<string[][]> {
  const out: string[][] = [];
  for (const n of [0, 1, 2, 3]) {
    out.push((await readLock(dir, `docs/spec/identity/handlers-${n}.lock.json`)).satisfied);
  }
  return out;
}

async function withMap(repo: GitRepo, map: object): Promise<Outcome> {
  await repo.write({ "renames.json": JSON.stringify(map) });
  return (await catspecJson<Outcome>(repo.dir, ["sync", "--map", "renames.json"])).json;
}

/** C# handler `Handler<n>` in namespace `<ns>.Handlers`, each with its own members and body. */
function handlerSource(ns: string, n: number): string {
  return `namespace ${ns}.Handlers;

public class Handler${n} : IHandler
{
    public void Handle${n}(string message)
    {
        var length = message.Length + ${n};
        Log("handler ${n}", length);
    }

    public int Count${n} { get; set; }

    private void Log(string text, int value) { }
}
`;
}

function identitySources(ns: string, folder = "Identity"): Record<string, string> {
  const files: Record<string, string> = {};
  for (let n = 0; n < 40; n++)
    files[`src/${folder}/Handlers/Handler${n}.cs`] = handlerSource(ns, n);
  return files;
}

const accountsSources = (): Record<string, string> => identitySources("Accounts", "Accounts");

/** 40 bound C# classes in namespace Identity.Handlers, in 4 implemented specs of 10 bindings. */
function identityRepo(): Record<string, string> {
  const files: Record<string, string> = {
    ...identitySources("Identity"),
    "src/Common/IHandler.cs": "namespace Common;\n\npublic interface IHandler { }\n",
  };
  for (let s = 0; s < 4; s++) {
    const bindings = [];
    for (let n = s * 10; n < s * 10 + 10; n++) {
      bindings.push(
        `- id: h${n}\n  symbol: Identity.Handlers.Handler${n}\n  kind: class\n  file: src/Identity/Handlers/*.cs\n  implements: [IHandler]\n  members:\n    - { name: Handle${n}, kind: method, params: [string] }\n    - Count${n}`,
      );
    }
    files[`docs/spec/identity/handlers-${s}.spec.md`] = spec(
      `handlers-${s}`,
      "implemented",
      bindings,
    );
  }
  return files;
}

/** `git mv` of the Identity folder to Accounts (the namespace is changed by the caller). */
function renameIdentityToAccounts(repo: GitRepo, options: { moveFolder: boolean }): void {
  if (options.moveFolder) repo.git("mv", "src/Identity", "src/Accounts");
}

function twinSource(first: string, second: string): string {
  const handler = (name: string): string => `export class ${name} {
  handle(event: string): void {
    console.info("event", event);
  }
}
`;
  return `${handler(first)}\n${handler(second)}`;
}

async function twinHandlers(repo: GitRepo): Promise<void> {
  await repo.write({
    [ADR_LOG]: adrLogText(),
    "docs/spec/events/event-handlers.spec.md": spec("event-handlers", "implemented", [
      binding("created", "CreatedHandler", "\n  members: [handle]"),
      binding("updated", "UpdatedHandler", "\n  members: [handle]"),
    ]),
    "src/events/handlers.ts": twinSource("CreatedHandler", "UpdatedHandler"),
  });
  await commitBaseline(repo);
}

async function userHandlerRepo(
  repo: GitRepo,
  options: { hint?: string; members?: string; implementsLine?: string; body?: string } = {},
): Promise<void> {
  await repo.write({
    [ADR_LOG]: adrLogText(),
    "docs/spec/users/user-handler.spec.md": spec(
      "user-handler",
      "implemented",
      [
        binding(
          "handler",
          "UserHandler",
          `${options.hint ?? ""}${options.implementsLine ?? ""}${options.members ?? "\n  members: [handle, close]"}`,
        ),
      ],
      options.body,
    ),
    "src/users/handler.ts": USER_HANDLER("UserHandler"),
  });
  await commitBaseline(repo);
}

function accountService(name: string): string {
  return `export class ${name} {
  open(owner: string): string {
    return \`${name.toLowerCase()}:\${owner}\`;
  }

  close(id: string): boolean {
    return id.startsWith("${name.slice(0, 3).toLowerCase()}");
  }
}

`;
}

/** Three bound services in src/accounts, in one implemented spec. */
async function accountRepo(repo: GitRepo): Promise<void> {
  await repo.write({
    [ADR_LOG]: adrLogText(),
    "docs/spec/accounts/accounts.spec.md": spec("accounts", "implemented", [
      binding("account", "AccountService", "\n  members: [open, close]"),
      binding("billing", "BillingService", "\n  members: [open, close]"),
      binding("audit", "AuditService", "\n  members: [open, close]"),
    ]),
    "src/accounts/services.ts":
      accountService("AccountService") +
      accountService("BillingService") +
      accountService("AuditService"),
  });
  await commitBaseline(repo);
}
