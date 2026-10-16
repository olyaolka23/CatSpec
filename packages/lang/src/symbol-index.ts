/**
 * The repository-wide symbol index (plan §D11.5, §D11.7, PBI `parse-cache-and-index`): finds a
 * symbol by its (qualified) name in every file of the language's include set. It is built on the
 * first lookup only, so commands that never need it don't parse the repository.
 */
import {
  WorkingTreeProvider,
  type FileFacts,
  type SourceProvider,
  type SymbolFact,
  type SymbolKind,
} from "@catspec/core";

import type { FactsProvider } from "./cache.js";
import type { AdapterRegistry } from "./registry.js";
import { nameMatches } from "./types.js";

export interface SymbolHit {
  /** File of the symbol, relative to the repository root. */
  path: string;
  id: string;
  qualifiedName: string;
  kind: SymbolKind;
}

export class SymbolIndex {
  private built?: Promise<Map<string, SymbolHit[]>>;

  /** @param load All facts of the repository, called once on the first lookup. */
  constructor(private readonly load: () => Promise<readonly FileFacts[]>) {}

  /**
   * Symbols whose qualified name ends with `name`, segment by segment: `AuthService` finds
   * `AuthService` and `Auth.AuthService`; `Auth.AuthService` finds only the latter.
   */
  async find(name: string): Promise<SymbolHit[]> {
    this.built ??= this.build();
    const byName = await this.built;
    const last = name.slice(name.lastIndexOf(".") + 1);
    return (byName.get(last) ?? []).filter((hit) => nameMatches(name, hit.qualifiedName));
  }

  private async build(): Promise<Map<string, SymbolHit[]>> {
    const byName = new Map<string, SymbolHit[]>();
    const add = (path: string, symbol: SymbolFact): void => {
      const hits = byName.get(symbol.name) ?? [];
      hits.push({ path, id: symbol.id, qualifiedName: symbol.qualifiedName, kind: symbol.kind });
      byName.set(symbol.name, hits);
      for (const member of symbol.members) add(path, member);
    };
    for (const facts of await this.load()) {
      for (const symbol of facts.symbols) add(facts.path, symbol);
    }
    return byName;
  }
}

/**
 * Facts of every file under `root` that a registered adapter accepts (by extension and the
 * `languages` globs), through the cache. Adapters are loaded first. `source` reads the files (the
 * working tree by default, or the git index); `only` limits them to some paths.
 */
export async function repositoryFacts(
  root: string,
  registry: AdapterRegistry,
  provider: FactsProvider,
  source: SourceProvider = new WorkingTreeProvider(root),
  only?: (path: string) => boolean,
): Promise<FileFacts[]> {
  await Promise.all(registry.adapters().map((adapter) => adapter.load()));
  const entries = (await source.list()).flatMap((entry) => {
    const adapter = registry.resolve(entry.path);
    return adapter && (!only || only(entry.path)) ? [{ ...entry, adapter }] : [];
  });
  // Read a few files at a time: enough to overlap disk and git reads, few enough open files.
  const facts: (FileFacts | undefined)[] = new Array<FileFacts | undefined>(entries.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < entries.length; i = next++) {
      const { path, blobSha, adapter } = entries[i]!;
      facts[i] = await provider.factsOf(adapter, path, blobSha, () => source.read(path));
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, entries.length) }, worker));
  return facts.filter((f): f is FileFacts => f !== undefined);
}
