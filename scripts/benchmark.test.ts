/**
 * Feature F9 `release-0-1`, PBI `performance-budgets` (plan §D11.7): the benchmark on the
 * synthetic 10k-file repository, and how it reports a check over its budget. CI also runs the
 * benchmark with the built CLI as a new process (`npm run bench`).
 */
import { describe, expect, it } from "vitest";

import { run } from "../packages/cli/src/index.js";
import { BUDGETS, budgets, evaluate, runBenchmark, type CatspecRunner } from "./benchmark.js";
import { syntheticRepo } from "./synthetic-repo.js";

/** The CLI in this process, from source. */
const inProcess: CatspecRunner = async (args, cwd) => {
  let output = "";
  const write = (text: string): boolean => {
    output += text;
    return true;
  };
  const code = await run(args, { cwd, stdout: { write }, stderr: { write } });
  return { code, output };
};

describe("F9 release-0-1: performance budgets (PBI performance-budgets)", () => {
  it("generates 10,000 TypeScript and C# files with bound specs in both languages", () => {
    const repo = syntheticRepo();
    const paths = Object.keys(repo.files);
    expect(paths.filter((p) => p.endsWith(".ts"))).toHaveLength(5001); // with the shared helper
    expect(paths.filter((p) => p.endsWith(".cs"))).toHaveLength(5000);
    expect(paths.filter((p) => p.endsWith(".spec.md"))).toHaveLength(40);
    expect(repo.bound.filter((p) => p.endsWith(".cs"))).toHaveLength(20);
  });

  it("[AC-F9-2] the staged check takes at most 1.1 seconds warm and the full check at most 10.5 seconds cold (13 seconds on Windows) on the synthetic 10k-file repository", async () => {
    const measurements = await runBenchmark({ catspec: inProcess });
    const { ok, report } = evaluate(measurements);
    console.log(report.join("\n"));
    expect(measurements.map((m) => [m.name, m.budgetMs])).toEqual([
      ["full check, cold", BUDGETS.fullColdMs],
      ["staged check, warm", BUDGETS.stagedWarmMs],
    ]);
    expect(ok, report.join("\n")).toBe(true);
  }, 600_000);

  it("[AC-performance-budgets-1] a warm staged check of 1.3 seconds fails the benchmark and is reported against the 1.1-second budget", () => {
    const linux = budgets("linux");
    const { ok, report } = evaluate([
      { name: "full check, cold", ms: 7400, budgetMs: linux.fullColdMs },
      { name: "staged check, warm", ms: 1300, budgetMs: linux.stagedWarmMs },
    ]);
    expect(ok).toBe(false);
    expect(report).toEqual([
      "ok   full check, cold: 7.40 s (budget 10.50 s)",
      "FAIL staged check, warm: 1.30 s (budget 1.10 s)",
      "benchmark: 1 check(s) over budget: staged check, warm took 1.30 s against 1.10 s",
    ]);
  });

  it("gives the full cold check 13 seconds on Windows and 10.5 seconds elsewhere, the staged check 1.1 seconds everywhere", () => {
    expect(budgets("win32")).toEqual({ stagedWarmMs: 1100, fullColdMs: 13_000 });
    expect(budgets("linux")).toEqual({ stagedWarmMs: 1100, fullColdMs: 10_500 });
    expect(budgets("darwin")).toEqual({ stagedWarmMs: 1100, fullColdMs: 10_500 });
  });
});
