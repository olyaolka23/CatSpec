import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BINDING_KINDS, MEMBER_KINDS, SYMBOL_KINDS } from "../src/index.js";

const core = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );

/** Module specifiers of the static and dynamic imports and re-exports of a source file. */
const importsOf = (text: string): string[] =>
  [
    ...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
    ...text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);

const isParserOrAdapter = (name: string): boolean =>
  name === "web-tree-sitter" || name.startsWith("tree-sitter") || name.startsWith("@catspec/lang");

describe("facts model", () => {
  it("[AC-adapter-interface-1] core depends on and imports neither web-tree-sitter nor any adapter package", () => {
    const pkg = JSON.parse(readFileSync(join(core, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const dependencies = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ].flatMap((field) => Object.keys(pkg[field] ?? {}));
    expect(dependencies.filter(isParserOrAdapter)).toEqual([]);

    const sources = filesUnder(join(core, "src")).filter((file) => /\.[cm]?ts$/.test(file));
    expect(sources.length).toBeGreaterThan(0);
    const imports = sources.flatMap((file) => importsOf(readFileSync(file, "utf8")));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter(isParserOrAdapter)).toEqual([]);
  });

  it("has a symbol kind for every binding kind and member kind, once", () => {
    expect([...SYMBOL_KINDS].sort()).toEqual(
      [...new Set([...BINDING_KINDS, ...MEMBER_KINDS])].sort(),
    );
  });
});
