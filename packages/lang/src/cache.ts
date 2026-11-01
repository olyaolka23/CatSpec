/**
 * The parse cache (plan §D11.7, analysis F-16, PBI `parse-cache-and-index`): facts are cached by
 * the git blob SHA of the file content in `<git-common-dir>/catspec/cache/<lang>/<blob-sha>.json`,
 * together with the adapter version that produced them. Outside a git repository the cache lives
 * in memory for the run.
 */
import { readdirSync, readFileSync, writeFile } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";

import {
  findGitCommonDir,
  gitBlobSha,
  MAX_SOURCE_BYTES,
  type FileFacts,
  type LanguageAdapter,
  type SourceFile,
  type SymbolFact,
} from "@catspec/core";

/** Cached facts, keyed by language and blob SHA, valid for one adapter version. */
export interface FactsCache {
  get(lang: string, blobSha: string, version: string): FileFacts | undefined;
  set(lang: string, version: string, facts: FileFacts): void;
  /** Waits for the writes `set` started. */
  flush?(): Promise<void>;
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
 * failed write is ignored: the cache only saves work. Writes run in the background, so a cold
 * run parses while earlier entries are written; `flush` waits for them. An entry is written in
 * place, without a temporary file and a rename (a cold run writes thousands, and each rename is
 * slow on Windows): an entry read while another process writes it doesn't parse and is a miss.
 */
export class DiskFactsCache implements FactsCache {
  private readonly folders = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<void>>();
  /** The entry names of each language folder: listed on first use, then the ones written. */
  private readonly listed = new Map<string, Set<string>>();
  /** Entries set in this run, served while (and after) they are written. */
  private readonly written = new MemoryFactsCache();

  constructor(readonly dir: string) {}

  get(lang: string, blobSha: string, version: string): FileFacts | undefined {
    const recent = this.written.get(lang, blobSha, version);
    if (recent) return recent;
    // A cold run misses on every file: one listing of the folder replaces a failed open per file.
    // An entry written by another process since then is a miss, which only costs a parse.
    if (!this.names(lang).has(`${safe(blobSha)}.json`)) return undefined;
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
    const content = JSON.stringify({ version, facts } satisfies Entry);
    this.written.set(lang, version, facts);
    const folder = join(this.dir, safe(lang));
    let created = this.folders.get(folder);
    if (!created) {
      created = mkdir(folder, { recursive: true });
      this.folders.set(folder, created);
    }
    const write = created
      .then(() => writeFileAsync(file, content))
      .then(() => {
        this.names(lang).add(`${safe(facts.blobSha)}.json`);
      })
      .catch(() =>
        // Best effort: another process may hold the file, or the folder may be read-only. A
        // half-written entry would only be a miss, but it is removed.
        rm(file, { force: true }).catch(() => {}),
      )
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  private names(lang: string): Set<string> {
    let names = this.listed.get(lang);
    if (!names) {
      try {
        names = new Set(readdirSync(join(this.dir, safe(lang))));
      } catch {
        names = new Set();
      }
      this.listed.set(lang, names);
    }
    return names;
  }

  private file(lang: string, blobSha: string): string {
    return join(this.dir, safe(lang), `${safe(blobSha)}.json`);
  }
}

// The callback API, promisified: `fs/promises` opens a FileHandle per file, which costs more per
// file than the write itself when a cold run writes thousands of entries.
const writeFileAsync = promisify(writeFile);

const safe = (segment: string): string => segment.replace(/[^A-Za-z0-9._-]/g, "_");

/** The cache for the repository at `root`: on disk in the git common dir, else in memory. */
export function factsCacheFor(root: string): FactsCache {
  const common = findGitCommonDir(root);
  return common ? new DiskFactsCache(join(common, "catspec", "cache")) : new MemoryFactsCache();
}

/**
 * Extracts facts through a cache: a file whose content is cached isn't parsed again. A file larger
 * than `MAX_SOURCE_BYTES`, or one the adapter throws on, gets empty facts marked `skipped`
 * (CS0901) instead of failing the run (spec §4 Robustness, PBI `robustness-fuzzing`).
 */
export class FactsProvider {
  constructor(readonly cache: FactsCache) {}

  /** Waits for the cache writes of the facts extracted so far. */
  async flush(): Promise<void> {
    await this.cache.flush?.();
  }

  facts(adapter: LanguageAdapter, file: SourceFile): FileFacts {
    const cached = this.cache.get(adapter.id, file.blobSha, adapter.version);
    // An adapter may parse by extension (TypeScript uses another grammar for `.tsx`), so facts
    // of the same content under another extension are extracted again.
    if (cached && extname(cached.path) === extname(file.path)) {
      return cached.path === file.path ? cached : relocate(cached, file.path);
    }
    if (Buffer.byteLength(file.text, "utf8") > MAX_SOURCE_BYTES) {
      return skippedFacts(adapter, file, `larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MiB`);
    }
    let extracted: FileFacts;
    try {
      extracted = adapter.extract(file);
    } catch (error) {
      // Not cached: a later adapter version may read the file.
      const reason = error instanceof Error ? error.message : String(error);
      return skippedFacts(adapter, file, `the ${adapter.id} adapter failed: ${reason}`);
    }
    const facts = withoutBodyTokens(extracted);
    this.cache.set(adapter.id, adapter.version, facts);
    return facts;
  }

  /**
   * The facts of a file whose blob SHA may be known without reading it (the git index): a cache
   * hit then skips reading the file. `read` returns undefined when the file is gone.
   */
  async factsOf(
    adapter: LanguageAdapter,
    path: string,
    blobSha: string | undefined,
    read: () => Promise<Buffer | undefined>,
  ): Promise<FileFacts | undefined> {
    if (blobSha !== undefined) {
      const cached = this.cache.get(adapter.id, blobSha, adapter.version);
      if (cached && extname(cached.path) === extname(path)) {
        return cached.path === path ? cached : relocate(cached, path);
      }
    }
    const bytes = await read();
    if (bytes === undefined) return undefined;
    return this.facts(adapter, { path, text: bytes.toString("utf8"), blobSha: gitBlobSha(bytes) });
  }
}

function skippedFacts(adapter: LanguageAdapter, file: SourceFile, skipped: string): FileFacts {
  return {
    path: file.path,
    blobSha: file.blobSha,
    lang: adapter.id,
    symbols: [],
    imports: [],
    calls: [],
    parseErrors: [],
    skipped,
  };
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
