/**
 * Feature F5 `git-integration-and-hook`: the hook's time budget (plan §D11.7, analysis F-16).
 * A 10 000-file repository with 20 specs, a warm parse cache, and a commit that changes the 20
 * bound files: `catspec check --staged` must finish in under a second.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { ADR_LOG, adrLogText, specText, withRepo } from "../../../test/temp-repo.js";
import { run } from "../src/index.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
/** The bin entry from source: the monorepo test rebuilds `dist/` while the tests run. */
const BIN_ARGS = [
  "--conditions=source",
  "--import",
  pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
  join(repoRoot, "packages", "cli", "src", "bin.ts"),
];

const FILES = 10_000;
const BOUND = 20;

/** A source file of the fixture; bound files are `Service<n>` with a `run` member. */
const source = (i: number, extra = ""): string =>
  `import { helper } from "../shared/helper";\n\nexport class Service${i} {\n` +
  `  run(input: string): number {\n    return helper(input) + ${i};${extra}\n  }\n\n` +
  `  stop(): void {}\n}\n`;

const quiet = { write: () => true };

describe("F5 git-integration-and-hook: performance", () => {
  it("[AC-F5-3] the staged check takes under 1 second on a 10k-file repository with a warm cache", async () => {
    const files: Record<string, string> = {
      [ADR_LOG]: adrLogText(),
      "src/shared/helper.ts": "export const helper = (s: string): number => s.length;\n",
    };
    for (let i = 0; i < FILES; i++) {
      files[`src/m${Math.floor(i / 100)}/Service${i}.ts`] = source(i);
    }
    const bound = Array.from({ length: BOUND }, (_, k) => k * (FILES / BOUND));
    for (const i of bound) {
      files[`docs/spec/f${i}/s${i}.spec.md`] = specText(`s${i}`, {
        status: "implemented",
        extra: `bindings:\n  - symbol: Service${i}\n    kind: class\n    members:\n      - { name: run, params: [string], returns: number }\n      - stop\n`,
      });
    }

    await withRepo(async (repo) => {
      // The lock files, and a warm cache: every file of the repository has been parsed once.
      expect(
        await run(["baseline", "--rebuild"], { cwd: repo.dir, stdout: quiet, stderr: quiet }),
      ).toBe(0);
      repo.git("add", ".");
      repo.git("commit", "-q", "--no-verify", "-m", "fixture");

      await repo.write(
        Object.fromEntries(
          bound.map((i) => [
            `src/m${Math.floor(i / 100)}/Service${i}.ts`,
            source(i, " // changed"),
          ]),
        ),
      );
      repo.git("add", "src");

      let output = "";
      const started = performance.now();
      const code = await run(["check", "--staged"], {
        cwd: repo.dir,
        stdout: { write: (text: string) => (output += text) },
        stderr: quiet,
      });
      const elapsed = performance.now() - started;
      expect(code, output).toBe(0);
      expect(output).toContain(`0 errors, 0 warnings in ${BOUND} specs`);
      expect(elapsed).toBeLessThan(1000);

      // The same check in a new process (startup and the TypeScript loader included), for the log.
      const spawnStarted = performance.now();
      const hook = spawnSync(process.execPath, [...BIN_ARGS, "check", "--staged"], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      const spawnElapsed = performance.now() - spawnStarted;
      expect(hook.status, hook.stdout + hook.stderr).toBe(0);
      console.log(
        `[AC-F5-3] check --staged: ${elapsed.toFixed(0)} ms in process, ` +
          `${spawnElapsed.toFixed(0)} ms as a new process`,
      );
    }, files);
  }, 600_000);
});
