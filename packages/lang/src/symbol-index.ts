/**
 * The repository-wide symbol index (plan §D11.5, §D11.7, PBI `parse-cache-and-index`): finds a
 * symbol by its (qualified) name in every file of the language's include set. It is built on the
 * first lookup only, so commands that never need it don't parse the repository.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  gitBlobSha,
  listFiles,
  type FileFacts,
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
 * `languages` globs), through the cache. Adapters are loaded first.
 */
export async function repositoryFacts(
  root: string,
  registry: AdapterRegistry,
  provider: FactsProvider,
): Promise<FileFacts[]> {
  await Promise.all(registry.adapters().map((adapter) => adapter.load()));
  const facts: FileFacts[] = [];
  for (const path of await listFiles(root)) {
    const adapter = registry.resolve(path);
    if (!adapter) continue;
    const bytes = await readFile(join(root, path));
    facts.push(
      provider.facts(adapter, { path, text: bytes.toString("utf8"), blobSha: gitBlobSha(bytes) }),
    );
  }
  return facts;
}
