/**
 * The code `catspec check` runs on: the facts of every file of the configured languages, through
 * the parse cache, and the language adapters the CLI injects into the engine (ADR-003).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  compareStrings,
  gitBlobSha,
  type CatspecConfig,
  type Codebase,
  type LanguageAdapter,
} from "@catspec/core";
import { AdapterRegistry, FactsProvider, factsCacheFor, repositoryFacts } from "@catspec/lang";
import { CSharpAdapter } from "@catspec/lang-csharp";
import { TypeScriptAdapter } from "@catspec/lang-typescript";

/** The language adapters the CLI ships with. */
export const defaultAdapters = (): LanguageAdapter[] => [
  new TypeScriptAdapter(),
  new CSharpAdapter(),
];

/** The adapters, loaded, for checks that need no code (`check --specs-only` compiles queries). */
export async function loadAdapters(config: CatspecConfig): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry(config.languages);
  for (const adapter of defaultAdapters()) registry.register(adapter);
  await Promise.all(registry.adapters().map((adapter) => adapter.load()));
  return registry;
}

/** Reads every source file of the repository at `root` (facts cached by blob SHA). */
export async function loadCodebase(root: string, config: CatspecConfig): Promise<Codebase> {
  const registry = await loadAdapters(config);
  const files = await repositoryFacts(root, registry, new FactsProvider(factsCacheFor(root)));
  files.sort((a, b) => compareStrings(a.path, b.path));
  return {
    files,
    adapter: (lang) => registry.get(lang),
    source: async (path) => {
      const bytes = await readFile(join(root, path));
      return { path, text: bytes.toString("utf8"), blobSha: gitBlobSha(bytes) };
    },
  };
}

/** A codebase without files, for `check --specs-only`. */
export async function emptyCodebase(config: CatspecConfig): Promise<Codebase> {
  const registry = await loadAdapters(config);
  return {
    files: [],
    adapter: (lang) => registry.get(lang),
    source: () => Promise.reject(new Error("no source files are read with --specs-only")),
  };
}
