import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts", "test/**/*.test.ts"],
    // The JSON results feed the acceptance-coverage check (scripts/check-acceptance.ts).
    reporters: ["default", "json"],
    outputFile: { json: "test-results/vitest.json" },
  },
});
