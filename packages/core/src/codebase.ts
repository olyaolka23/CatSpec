/**
 * The code a check runs on (plan §D11.3): the facts of every source file of the configured
 * languages and the adapters that produced them. `cli` and `mcp` build it with the adapters they
 * inject (ADR-003); the rule engine reads only these facts, plus raw syntax for `query` rules
 * through the adapter.
 */
import type { Location } from "./diagnostics.js";
import type { FileFacts, LanguageAdapter, Range, SourceFile, SymbolFact } from "./facts.js";
import { qualifiedNameMatches } from "./match.js";

export interface Codebase {
  /** Facts of every source file, sorted by path. */
  readonly files: readonly FileFacts[];
  /** The adapter of a language id, if one is installed. */
  adapter(lang: string): LanguageAdapter | undefined;
  /** The source of a file of `files`, for `query` rules. */
  source(path: string): Promise<SourceFile>;
}

/** A declaration with the file it is in. */
export interface SymbolEntry {
  symbol: SymbolFact;
  file: FileFacts;
}

/** Every declaration of a codebase, top-level and nested, indexed by simple name. */
export class SymbolTable {
  readonly entries: SymbolEntry[] = [];
  private readonly byName = new Map<string, SymbolEntry[]>();
  readonly byPath = new Map<string, FileFacts>();

  constructor(files: readonly FileFacts[]) {
    const add = (symbol: SymbolFact, file: FileFacts): void => {
      const entry = { symbol, file };
      this.entries.push(entry);
      const named = this.byName.get(symbol.name);
      if (named) named.push(entry);
      else this.byName.set(symbol.name, [entry]);
      for (const member of symbol.members) add(member, file);
    };
    for (const file of files) {
      this.byPath.set(file.path, file);
      for (const symbol of file.symbols) add(symbol, file);
    }
  }

  /**
   * Declarations whose qualified name matches `name` (segment-wise suffix; `*` wildcards), in
   * file order.
   */
  find(name: string): SymbolEntry[] {
    if (name.includes("*")) {
      return this.entries.filter((e) => qualifiedNameMatches(name, e.symbol.qualifiedName));
    }
    const last = name.slice(name.lastIndexOf(".") + 1);
    return (this.byName.get(last) ?? []).filter((e) =>
      qualifiedNameMatches(name, e.symbol.qualifiedName),
    );
  }
}

/** A location in the code. */
export const codeLocation = (file: string, range: Range): Location => ({
  file,
  line: range.start.line,
  column: range.start.column,
  endLine: range.end.line,
  endColumn: range.end.column,
});

/** `file:line:column` of a range, for messages. */
export const formatLocation = (file: string, range: Range): string =>
  `${file}:${range.start.line}:${range.start.column}`;

const comparePositions = (a: Range["start"], b: Range["start"]): number =>
  a.line - b.line || a.column - b.column;

/** True when `outer` contains `inner`. */
export const rangeContains = (outer: Range, inner: Range): boolean =>
  comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
