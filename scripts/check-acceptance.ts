/**
 * Acceptance-coverage check, run in CI after `npm test` (see ./acceptance-coverage.ts).
 *
 * Usage: tsx scripts/check-acceptance.ts [--root <dir>] [--results <vitest-json>] [--all]
 */
import { run } from "./acceptance-coverage.js";

process.exitCode = run(process.argv.slice(2));
