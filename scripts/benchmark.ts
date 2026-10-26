/**
 * The performance benchmark (plan §D11.7, analysis F-16, PBI `performance-budgets`): on the
 * synthetic 10k-file repository (./synthetic-repo.ts) the CLI runs both checks, and each measured
 * time is compared with its budget. `npm run bench` runs the built CLI as a new process, the way the
 * pre-commit hook and CI run it; the test runs it in process.
 *
 * - full check, cold: `catspec check` with an empty parse cache, at most 10.5 seconds;
 * - staged check, warm: `catspec check --staged` on a commit that changes every bound file, with
 *   the cache filled, at most 1.1 seconds (the median of three runs).
 *
 * The CLI entry point is `scripts/run-benchmark.ts` (`npm run bench`).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changedSource, writeSyntheticRepo } from "./synthetic-repo.js";

export interface Measurement {
  name: string;
  ms: number;
  budgetMs: number;
}

export interface BenchmarkResult {
  ok: boolean;
  /** One line per measurement, then the verdict. */
  report: string[];
}

/**
 * The plan's 1 s and 10 s (§D11.7) with the margin the owner set on 2026-10-24 for the time shared
 * CI runners vary.
 */
export const BUDGETS = { stagedWarmMs: 1100, fullColdMs: 10_500 } as const;

/** Compares each measured time with its budget. */
export function evaluate(measurements: Measurement[]): BenchmarkResult {
  const over = measurements.filter((m) => m.ms > m.budgetMs);
  const report = measurements.map(
    (m) =>
      `${m.ms > m.budgetMs ? "FAIL" : "ok  "} ${m.name}: ${format(m.ms)} ` +
      `(budget ${format(m.budgetMs)})`,
  );
  report.push(
    over.length === 0
      ? "benchmark: every check is within its budget"
      : `benchmark: ${over.length} check(s) over budget: ` +
          over
            .map((m) => `${m.name} took ${format(m.ms)} against ${format(m.budgetMs)}`)
            .join("; "),
  );
  return { ok: over.length === 0, report };
}

const format = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** Runs `catspec <args>` in `cwd`: its exit code and output. */
export type CatspecRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; output: string }>;

/** Runs the CLI as a new process: `command` is e.g. `[process.execPath, "packages/cli/dist/bin.js"]`. */
export const processRunner =
  (command: string[]): CatspecRunner =>
  (args, cwd) => {
    const [program, ...rest] = command;
    const result = spawnSync(program!, [...rest, ...args], { cwd, encoding: "utf8" });
    return Promise.resolve({ code: result.status ?? 1, output: result.stdout + result.stderr });
  };

export interface BenchmarkOptions {
  catspec: CatspecRunner;
  /** Source files of the synthetic repository. */
  files?: number;
  /** Called with each line of progress. */
  log?: (line: string) => void;
}

/** Generates the synthetic repository in a temporary folder and measures both checks. */
export async function runBenchmark(options: BenchmarkOptions): Promise<Measurement[]> {
  const log = options.log ?? (() => {});
  const dir = await mkdtemp(join(tmpdir(), "catspec-bench-"));
  try {
    const repo = await writeSyntheticRepo(
      dir,
      options.files === undefined ? {} : { files: options.files },
    );
    log(`synthetic repository: ${Object.keys(repo.files).length} files in ${dir}`);

    const catspec = async (...command: string[]): Promise<number> => {
      const started = performance.now();
      const { code, output } = await options.catspec(command, dir);
      const ms = performance.now() - started;
      if (code !== 0) throw new Error(`catspec ${command.join(" ")} exited ${code}:\n${output}`);
      return ms;
    };
    const git = (...command: string[]): void => {
      const result = spawnSync("git", command, { cwd: dir, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${command.join(" ")}: ${result.stderr}`);
    };

    // The lock files, committed as a team would have them.
    await catspec("baseline", "--rebuild");
    git("add", ".");
    git("commit", "-q", "--no-verify", "-m", "lock files");

    await rm(join(dir, ".git", "catspec", "cache"), { recursive: true, force: true });
    const fullColdMs = await catspec("check");
    log(`full check, cold: ${format(fullColdMs)}`);

    for (const file of repo.bound) await writeFile(join(dir, file), changedSource(file), "utf8");
    git("add", ".");
    const staged: number[] = [];
    for (let i = 0; i < 3; i++) staged.push(await catspec("check", "--staged"));
    log(`staged check, warm: ${staged.map(format).join(", ")}`);

    return [
      { name: "full check, cold", ms: fullColdMs, budgetMs: BUDGETS.fullColdMs },
      { name: "staged check, warm", ms: median(staged), budgetMs: BUDGETS.stagedWarmMs },
    ];
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}
