/**
 * The code `catspec check` runs on: the facts of every file of the configured languages, through
 * the parse cache, and the language adapters the CLI injects into the engine (ADR-003). Files are
 * read from a source provider: the working tree, or the git index for `check --staged`.
 */
import {
  compareStrings,
  gitBlobSha,
  WorkingTreeProvider,
  type CatspecConfig,
  type Codebase,
  type LanguageAdapter,
  type SourceProvider,
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

export interface CodebaseOptions {
  /** Where files are read from (default: the working tree). */
  source?: SourceProvider;
  /** Only these files (default: every source file). */
  only?: (path: string) => boolean;
  /** Loaded adapters to reuse. */
  registry?: AdapterRegistry;
}

/** Reads the source files of the repository at `root` (facts cached by blob SHA). */
export async function loadCodebase(
  root: string,
  config: CatspecConfig,
  options: CodebaseOptions = {},
): Promise<Codebase> {
  const registry = options.registry ?? (await loadAdapters(config));
  const source = options.source ?? new WorkingTreeProvider(root);
  const files = await repositoryFacts(
    root,
    registry,
    new FactsProvider(factsCacheFor(root)),
    source,
    options.only,
  );
  files.sort((a, b) => compareStrings(a.path, b.path));
  return {
    files,
    adapter: (lang) => registry.get(lang),
    source: async (path) => {
      const bytes = await source.read(path);
      if (bytes === undefined) throw new Error(`no such file: ${path}`);
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
