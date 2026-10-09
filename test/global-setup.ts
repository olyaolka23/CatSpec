import { rm } from "node:fs/promises";

import { resultsFile } from "../vitest.config.js";

/**
 * Deletes the previous run's JSON results before the tests start. A run that doesn't write them
 * (for example with `--reporter=dot`) then leaves no file, and the acceptance-coverage check
 * fails with "run npm test first" instead of checking stale results.
 */
export default async function setup(): Promise<void> {
  await rm(resultsFile, { force: true });
}
