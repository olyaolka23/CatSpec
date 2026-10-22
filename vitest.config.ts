import { fileURLToPath } from "node:url";

import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

/** JSON test results read by the acceptance-coverage check (scripts/check-acceptance.ts). */
export const resultsFile = fileURLToPath(new URL("./test-results/vitest.json", import.meta.url));

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources through the `source` export condition,
  // the same way tsc and ESLint resolve them (`customConditions` in tsconfig.base.json).
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
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
