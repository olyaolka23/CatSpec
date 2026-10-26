/**
 * `catspec uninstall`: takes out what `init --hooks --agents` wired in, and with `--files` the
 * files `init` wrote while they are unchanged. The pre-commit hook lets commits through when
 * CatSpec isn't installed, so removing the package never blocks a commit.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { withRepo } from "../../../test/temp-repo.js";
import { withoutAgentsBlock, withoutStopHook, withStopHook } from "../src/agents-setup.js";
import { run } from "../src/index.js";

async function catspec(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await run(args, {
    cwd,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stdout += text) },
  });
  return { code, stdout };
}

const TEAM_AGENTS = "# Team rules\n\nBe kind.\n";
const TEAM_SETTINGS = `${JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: "command", command: "npm run lint" }] }] } },
  null,
  2,
)}\n`;

describe("catspec uninstall", () => {
  it("removes the hooks and the AGENTS.md block, keeping the team's own content byte for byte", async () => {
    await withRepo(
      async (repo) => {
        expect((await catspec(repo.dir, ["init", "--hooks", "--agents"])).code).toBe(0);
        const hook = join(repo.dir, ".git", "hooks", "pre-commit");
        expect(existsSync(hook)).toBe(true);

        const result = await catspec(repo.dir, ["uninstall"]);
        expect(result.code, result.stdout).toBe(0);
        expect(existsSync(hook)).toBe(false);
        expect(await readFile(join(repo.dir, "AGENTS.md"), "utf8")).toBe(TEAM_AGENTS);
        expect(JSON.parse(await readFile(join(repo.dir, ".claude/settings.json"), "utf8"))).toEqual(
          JSON.parse(TEAM_SETTINGS),
        );
        // The files init wrote stay without --files.
        expect(existsSync(join(repo.dir, "catspec.yaml"))).toBe(true);
        expect(result.stdout).toContain("catspec uninstall --files");

        // Nothing left to remove the second time.
        expect((await catspec(repo.dir, ["uninstall"])).stdout).toContain(
          "nothing of CatSpec was installed here",
        );
      },
      { "AGENTS.md": TEAM_AGENTS, ".claude/settings.json": TEAM_SETTINGS },
    );
  });

  it("--files deletes catspec.yaml, the cache and init's unchanged files, and keeps specs and edited files", async () => {
    await withRepo(async (repo) => {
      expect((await catspec(repo.dir, ["init", "--agents", "--name", "shop"])).code).toBe(0);
      await repo.write({ "src/greeter.ts": "export class Greeter {}\n" });
      expect((await catspec(repo.dir, ["check"])).code).toBe(0);
      expect(existsSync(join(repo.dir, ".git", "catspec"))).toBe(true);
      // A spec of the team's, and an edit to the example plan.
      await repo.write({
        "docs/spec/cart/cart.spec.md":
          "---\ncatspec: 1\nid: cart\ntype: feature\nstatus: draft\n---\n# Cart\n",
        "docs/spec/example-feature/plan.md": "# Our plan\n",
      });

      const result = await catspec(repo.dir, ["uninstall", "--files"]);
      expect(result.code, result.stdout).toBe(0);
      for (const gone of [
        "catspec.yaml",
        "AGENTS.md",
        ".claude/settings.json",
        "docs/architecture/adr/shop-adr.md",
        "docs/spec/example-feature/spec.md",
        "docs/spec/example-feature/example-greeter.spec.md",
        ".git/catspec",
      ]) {
        expect(existsSync(join(repo.dir, gone)), gone).toBe(false);
      }
      expect(existsSync(join(repo.dir, "docs/spec/example-feature/plan.md"))).toBe(true);
      expect(existsSync(join(repo.dir, "docs/spec/cart/cart.spec.md"))).toBe(true);
      expect(result.stdout).toContain("kept docs/spec/example-feature/plan.md (edited since init)");
      expect(result.stdout).toContain("kept 1 spec and lock file(s)");
    });
  });

  it("keeps an ADR log that has the team's decisions", async () => {
    await withRepo(async (repo) => {
      await catspec(repo.dir, ["init", "--name", "shop"]);
      const log = join(repo.dir, "docs/architecture/adr/shop-adr.md");
      await writeFile(log, `${await readFile(log, "utf8")}\n## ADR-002: Use events\n`);
      const result = await catspec(repo.dir, ["uninstall", "--files"]);
      expect(existsSync(log)).toBe(true);
      expect(result.stdout).toContain("kept docs/architecture/adr/shop-adr.md");
    });
  });

  it("the pre-commit hook lets the commit through, and says why, when CatSpec isn't installed", async () => {
    await withRepo(
      async (repo) => {
        await catspec(repo.dir, ["install-hooks"]);
        repo.git("add", "-A");
        // No CatSpec on the PATH and no node_modules/.bin/catspec in the repository.
        const path = (process.env.PATH ?? "")
          .split(delimiter)
          .filter((dir) => !dir.includes("node_modules"))
          .join(delimiter);
        const commit = spawnSync("git", ["commit", "-q", "-m", "no catspec"], {
          cwd: repo.dir,
          encoding: "utf8",
          env: { ...process.env, PATH: path },
        });
        expect(commit.status, commit.stderr).toBe(0);
        expect(commit.stderr).toContain("catspec: not installed, so the CatSpec check is skipped");
      },
      { "src.ts": "export const one = 1;\n" },
    );
  });

  it("removal helpers leave other content alone", () => {
    expect(withoutAgentsBlock("# Rules\n")).toBe("# Rules\n");
    expect(withoutStopHook(TEAM_SETTINGS)).toBe(TEAM_SETTINGS);
    expect(withoutStopHook(withStopHook(undefined))).toBeUndefined();
    expect(withoutStopHook("not json")).toBe("not json");
  });
});
