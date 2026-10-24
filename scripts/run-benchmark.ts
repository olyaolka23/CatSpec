/**
 * Runs the performance benchmark (./benchmark.ts) with the built CLI. Exits 1 when a check is
 * over its budget. Build first (`npm run build`).
 *
 * Usage: tsx scripts/run-benchmark.ts [--files <n>]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, processRunner, runBenchmark } from "./benchmark.js";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const filesIndex = process.argv.indexOf("--files");
const files = filesIndex >= 0 ? Number(process.argv[filesIndex + 1]) : undefined;

const measurements = await runBenchmark({
  catspec: processRunner([process.execPath, resolve(root, "packages", "cli", "dist", "bin.js")]),
  ...(files === undefined ? {} : { files }),
  log: (line) => console.log(line),
});
const { ok, report } = evaluate(measurements);
for (const line of report) (ok ? console.log : console.error)(line);
process.exitCode = ok ? 0 : 1;
