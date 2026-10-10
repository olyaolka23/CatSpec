/**
 * Writes the JSON Schemas of `catspec.yaml` and of the spec frontmatter to `packages/core/schemas/`
 * (PBI `config-loader`), for editor autocompletion. Run `npm run schemas` after changing a schema;
 * a test fails while the files are out of date.
 *
 * Usage: tsx scripts/generate-schemas.ts [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import { configJsonSchema, specJsonSchema } from "../packages/core/src/index.js";

export const schemasDir = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "packages",
  "core",
  "schemas",
);

const SCHEMAS: Record<string, () => Record<string, unknown>> = {
  "catspec.schema.json": () => ({ title: "catspec.yaml", ...configJsonSchema() }),
  "spec.schema.json": () => ({ title: "CatSpec spec frontmatter", ...specJsonSchema() }),
};

/** The formatted text of every schema file, by file name. */
export async function renderSchemas(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const path = join(schemasDir, name);
    const options = (await resolveConfig(path)) ?? {};
    files[name] = await format(JSON.stringify(schema()), { ...options, filepath: path });
  }
  return files;
}

async function main(check: boolean): Promise<number> {
  const stale: string[] = [];
  for (const [name, text] of Object.entries(await renderSchemas())) {
    const path = join(schemasDir, name);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === text) continue;
    if (check) stale.push(name);
    else await writeFile(path, text, "utf8");
  }
  if (stale.length > 0) {
    console.error(`schemas out of date: ${stale.join(", ")}; run "npm run schemas"`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.includes("--check"));
}
