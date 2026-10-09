import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderSchemas, schemasDir } from "../../../scripts/generate-schemas.js";
import { configJsonSchema, specJsonSchema } from "../src/index.js";

describe("JSON Schemas", () => {
  it("are up to date in packages/core/schemas (run `npm run schemas` after a schema change)", async () => {
    for (const [name, text] of Object.entries(await renderSchemas())) {
      expect(readFileSync(join(schemasDir, name), "utf8"), name).toBe(text);
    }
  });

  it("describe catspec.yaml with its defaults and the spec frontmatter with its required keys", () => {
    const config = configJsonSchema() as { properties: Record<string, { default?: unknown }> };
    expect(config.properties.layout!.default).toBe("feature-folders");
    expect(Object.keys(config.properties)).toEqual(
      expect.arrayContaining([
        "layout",
        "specs",
        "languages",
        "enforcement",
        "heal",
        "hook",
        "refactor",
        "mcp",
      ]),
    );
    const spec = specJsonSchema() as { required: string[]; additionalProperties?: unknown };
    expect(spec.required).toEqual(["catspec", "id", "type", "status"]);
    expect(spec.additionalProperties).not.toBe(false);
  });
});
