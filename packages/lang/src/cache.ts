/**
 * The parse cache (plan §D11.7, analysis F-16, PBI `parse-cache-and-index`): facts are cached by
 * the git blob SHA of the file content in `<git-common-dir>/catspec/cache/<lang>/<blob-sha>.json`,
 * together with the adapter version that produced them. Outside a git repository the cache lives
 * in memory for the run.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pid } from "node:process";

import {
  findGitCommonDir,
  type FileFacts,
  type LanguageAdapter,
  type SourceFile,
  type SymbolFact,
} from "@catspec/core";

/** Cached facts, keyed by language and blob SHA, valid for one adapter version. */
export interface FactsCache {
  get(lang: string, blobSha: string, version: string): FileFacts | undefined;
  set(lang: string, version: string, facts: FileFacts): void;
}

interface Entry {
  version: string;
  facts: FileFacts;
}

/** A cache for one run. */
export class MemoryFactsCache implements FactsCache {
  private readonly entries = new Map<string, Entry>();

  get(lang: string, blobSha: string, version: string): FileFacts | undefined {
    const entry = this.entries.get(`${lang}/${blobSha}`);
    return entry?.version === version ? entry.facts : undefined;
  }

  set(lang: string, version: string, facts: FileFacts): void {
    this.entries.set(`${lang}/${facts.blobSha}`, { version, facts });
  }
}

/**
 * A cache in a folder, one JSON file per blob. Unreadable or outdated entries are misses, and a
 * failed write is ignored: the cache only saves work.
 */
export class DiskFactsCache implements FactsCache {
  constructor(readonly dir: string) {}

  get(lang: string, blobSha: string, version: string): FileFacts | undefined {
    try {
      const entry = JSON.parse(readFileSync(this.file(lang, blobSha), "utf8")) as Entry;
      return entry.version === version && entry.facts?.blobSha === blobSha
        ? entry.facts
        : undefined;
    } catch {
      return undefined;
    }
  }

  set(lang: string, version: string, facts: FileFacts): void {
    const file = this.file(lang, facts.blobSha);
    const temp = `${file}.${pid}.tmp`;
    try {
      mkdirSync(join(this.dir, safe(lang)), { recursive: true });
      writeFileSync(temp, JSON.stringify({ version, facts } satisfies Entry));
      renameSync(temp, file);
    } catch {
      // Best effort: another process may hold the file, or the folder may be read-only.
    }
  }

  private file(lang: string, blobSha: string): string {
    return join(this.dir, safe(lang), `${safe(blobSha)}.json`);
  }
}

const safe = (segment: string): string => segment.replace(/[^A-Za-z0-9._-]/g, "_");

/** The cache for the repository at `root`: on disk in the git common dir, else in memory. */
export function factsCacheFor(root: string): FactsCache {
  const common = findGitCommonDir(root);
  return common ? new DiskFactsCache(join(common, "catspec", "cache")) : new MemoryFactsCache();
}

/** Extracts facts through a cache: a file whose content is cached isn't parsed again. */
export class FactsProvider {
  constructor(readonly cache: FactsCache) {}

  facts(adapter: LanguageAdapter, file: SourceFile): FileFacts {
    const cached = this.cache.get(adapter.id, file.blobSha, adapter.version);
    if (cached) return cached.path === file.path ? cached : relocate(cached, file.path);
    const facts = withoutBodyTokens(adapter.extract(file));
    this.cache.set(adapter.id, adapter.version, facts);
    return facts;
  }
}

/** Body tokens are only for rename detection in the current run; they aren't cached. */
function withoutBodyTokens(facts: FileFacts): FileFacts {
  const strip = (symbol: SymbolFact): SymbolFact => {
    const copy = { ...symbol, members: symbol.members.map(strip) };
    delete copy.bodyTokens;
    return copy;
  };
  return { ...facts, symbols: facts.symbols.map(strip) };
}

/** The same content at another path (a copy): ids start with the path, so rewrite them. */
function relocate(facts: FileFacts, path: string): FileFacts {
  const from = `${facts.path}#`;
  const to = `${path}#`;
  const id = (value: string): string =>
    value.startsWith(from) ? to + value.slice(from.length) : value;
  const move = (symbol: SymbolFact): SymbolFact => ({
    ...symbol,
    id: id(symbol.id),
    members: symbol.members.map(move),
  });
  return {
    ...facts,
    path,
    symbols: facts.symbols.map(move),
    calls: facts.calls.map((call) =>
      call.enclosing === undefined ? call : { ...call, enclosing: id(call.enclosing) },
    ),
  };
}
