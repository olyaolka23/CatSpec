/**
 * Feature F9 `release-0-1`, PBI `example-repos`: the scripted journeys of the example repositories
 * in `examples/`, run with the CLI from source on a copy of each example in a new git repository.
 * Each journey ends with every spec implemented and `catspec check` exiting 0.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { run } from "../packages/cli/src/index.js";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A copy of `examples/<name>` in a new git repository, committed. */
function checkout(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `catspec-${name}-`));
  temps.push(dir);
  cpSync(join(root, "examples", name), dir, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "example@example.com");
  git("config", "user.name", "CatSpec example");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "-m", "start");

  const catspec = async (...args: string[]): Promise<{ code: number; output: string }> => {
    let output = "";
    const write = (text: string): boolean => {
      output += text;
      return true;
    };
    const code = await run(args, { cwd: dir, stdout: { write }, stderr: { write } });
    return { code, output };
  };
  /** `git commit` the way the pre-commit hook would let it through: the staged check first. */
  const commit = async (message: string): Promise<{ code: number; output: string }> => {
    git("add", "-A");
    const hook = await catspec("check", "--staged");
    if (hook.code === 0) git("commit", "-q", "--no-verify", "-m", message);
    return hook;
  };
  const edit = (file: string, from: string, to: string): void => {
    const path = join(dir, file);
    writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
  };
  return { dir, git, catspec, commit, edit };
}

/** Every spec is implemented and the full check passes. */
async function expectAllImplemented(catspec: ReturnType<typeof checkout>["catspec"]) {
  const list = await catspec("list", "--format", "json");
  expect(list.code).toBe(0);
  const specs = JSON.parse(list.output) as { id: string; status: string }[];
  expect(specs.filter((s) => s.status !== "implemented").map((s) => s.id)).toEqual([]);
  const check = await catspec("check");
  expect(check.code, check.output).toBe(0);
  expect(check.output).toMatch(/0 errors, 0 warnings/);
}

describe("F9 release-0-1: example repositories (PBI example-repos)", () => {
  it("[AC-example-repos-1] the TypeScript AuthService and the .NET user sync journeys end with every spec implemented and catspec check exiting 0", async () => {
    // TypeScript: implement user-auth-service, then a rename is blocked (spec AC-1).
    const ts = checkout("ts-auth-service");
    expect((await ts.catspec("check")).code).toBe(0);
    expect((await ts.catspec("status", "user-auth-service", "in-progress")).code).toBe(0);
    const done = await ts.catspec("check", "--spec", "user-auth-service");
    expect(done.output).toContain("DONE");
    expect(done.code).toBe(0);
    expect((await ts.catspec("status", "user-auth-service", "implemented")).code).toBe(0);
    expect((await ts.commit("auth service")).code).toBe(0);

    ts.edit("src/services/AuthService.ts", "validateToken(", "checkToken(");
    const blocked = await ts.commit("rename");
    expect(blocked.code, blocked.output).toBe(1);
    expect(blocked.output).toContain("did you mean checkToken?");
    ts.git("checkout", "-q", "HEAD", "--", "src");
    ts.git("add", "-A");
    await expectAllImplemented(ts.catspec);

    // .NET: implement user-sync-handler, then rename the class and heal the spec (spec AC-2).
    const cs = checkout("dotnet-user-sync");
    expect((await cs.catspec("status", "user-sync-handler", "in-progress")).code).toBe(0);
    expect((await cs.catspec("status", "user-sync-handler", "implemented")).code).toBe(0);
    expect((await cs.commit("user sync handler")).code).toBe(0);

    const handlers = join(cs.dir, "src", "Services", "Identity", "Handlers");
    renameSync(join(handlers, "UserHandler.cs"), join(handlers, "UserUpdatedHandler.cs"));
    cs.edit(
      "src/Services/Identity/Handlers/UserUpdatedHandler.cs",
      "class UserHandler",
      "class UserUpdatedHandler",
    );
    const renamed = await cs.commit("rename");
    expect(renamed.code, renamed.output).toBe(1);
    expect(renamed.output).toContain("CS0210");
    expect((await cs.catspec("sync", "--apply")).code).toBe(0);
    expect((await cs.commit("rename")).code).toBe(0);
    expect(
      readFileSync(join(cs.dir, "docs/spec/user-sync/user-sync-handler.spec.md"), "utf8"),
    ).toContain("symbol: Identity.Handlers.UserUpdatedHandler");
    await expectAllImplemented(cs.catspec);
  }, 120_000);
});
