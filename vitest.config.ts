import { fileURLToPath } from "node:url";

import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

/** JSON test results read by the acceptance-coverage check (scripts/check-acceptance.ts). */
export const resultsFile = fileURLToPath(new URL("./test-results/vitest.json", import.meta.url));

const BENCHMARK = "scripts/benchmark.test.ts";

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources through the `source` export condition,
  // the same way tsc and ESLint resolve them (`customConditions` in tsconfig.base.json).
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  test: {
    globalSetup: ["test/global-setup.ts"],
    // The benchmark measures time budgets (plan §D11.7), so it runs alone, after the other tests.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [BENCHMARK],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: "benchmark", include: [BENCHMARK], sequence: { groupOrder: 1 } },
      },
    ],
    // `eventsource`, which the MCP client of the tests imports, publishes its TypeScript sources
    // under the `source` condition too, and Node can't strip types under node_modules: Vite
    // transforms the client and it instead.
    server: { deps: { inline: ["@modelcontextprotocol/client", "eventsource"] } },
    // Setting reporters turns off Vitest's automatic GitHub Actions reporter, so add it back.
    reporters: [
      "default",
      "json",
      ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
    ],
    outputFile: { json: resultsFile },
  },
});
