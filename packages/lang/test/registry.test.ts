import { defaultConfig, type FileFacts, type LanguageAdapter } from "@catspec/core";
import { describe, expect, it } from "vitest";

import { AdapterRegistry } from "../src/index.js";

/** An adapter that extracts nothing; the registry only reads `id` and `extensions`. */
function fakeAdapter(id: string, extensions: string[]): LanguageAdapter {
  return {
    id,
    extensions,
    version: "1",
    load: () => Promise.resolve(),
    extract: (file): FileFacts => ({
      path: file.path,
      blobSha: file.blobSha,
      lang: id,
      symbols: [],
      imports: [],
      calls: [],
      parseErrors: [],
    }),
    normalizeType: (text) => ({ text, name: [text], args: [] }),
    qualify: (symbol) => symbol.qualifiedName,
  };
}

const typescript = fakeAdapter("typescript", [".ts", ".tsx"]);
const csharp = fakeAdapter("csharp", [".cs"]);

describe("adapter registry", () => {
  it('[AC-adapter-interface-2] routes "src/a.ts" to the TypeScript adapter and ignores "docs/b.ts"', () => {
    const registry = new AdapterRegistry({
      typescript: { include: ["src/**/*.ts"], exclude: [] },
    }).register(typescript);

    expect(registry.resolve("src/a.ts")).toBe(typescript);
    expect(registry.resolve("docs/b.ts")).toBeUndefined();
  });

  it("uses the default language globs of catspec.yaml", () => {
    const registry = new AdapterRegistry(defaultConfig().languages)
      .register(typescript)
      .register(csharp);

    expect(registry.resolve("src/app/main.tsx")).toBe(typescript);
    expect(registry.resolve("src/Api/Program.cs")).toBe(csharp);
    expect(registry.resolve("src/types/env.d.ts")).toBeUndefined();
    expect(registry.resolve("src/node_modules/x/index.ts")).toBeUndefined();
    expect(registry.resolve("src/Api/obj/Generated.cs")).toBeUndefined();
    expect(registry.resolve("src/readme.md")).toBeUndefined();
  });

  it("needs both a matching extension and a matching include glob", () => {
    const registry = new AdapterRegistry({
      typescript: { include: ["src/**"], exclude: [] },
    }).register(typescript);

    expect(registry.resolve("src/a.ts")).toBe(typescript);
    expect(registry.resolve("src/a.js")).toBeUndefined();
  });

  it("gives no files to an adapter without a language entry", () => {
    const registry = new AdapterRegistry({}).register(typescript);

    expect(registry.resolve("src/a.ts")).toBeUndefined();
    expect(registry.get("typescript")).toBe(typescript);
  });

  it("lists adapters in registration order and rejects a duplicate id", () => {
    const registry = new AdapterRegistry({}).register(csharp).register(typescript);

    expect(registry.adapters().map((a) => a.id)).toEqual(["csharp", "typescript"]);
    expect(() => registry.register(fakeAdapter("typescript", [".mts"]))).toThrow(
      /"typescript" is already registered/,
    );
  });
});
