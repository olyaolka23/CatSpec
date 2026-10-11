/**
 * The language-independent facts model (plan §D11.2, ADR-003). Language adapters turn a source
 * file into `FileFacts`; rules and binding resolution read only these facts, never syntax trees,
 * so `core` stays free of Tree-sitter and of every adapter.
 */
import { createDiagnostic, type Diagnostic } from "./diagnostics.js";
import { BINDING_KINDS, MEMBER_KINDS } from "./spec-schema.js";

/** Every kind a symbol fact can have: the binding kinds plus the member kinds. */
export const SYMBOL_KINDS = [...new Set([...BINDING_KINDS, ...MEMBER_KINDS])] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** A position in a source file: 1-based line, 1-based column in UTF-16 code units. */
export interface Position {
  line: number;
  column: number;
}

/** A span of a source file; `end` is exclusive. */
export interface Range {
  start: Position;
  end: Position;
}

/** A source file handed to an adapter. */
export interface SourceFile {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  text: string;
  /** Git blob SHA of `text`: the cache key of the facts. */
  blobSha: string;
}

/**
 * A type reference as written, normalised by the adapter: `Contracts.IHandler<Events.Created>`
 * is `{ name: ["Contracts", "IHandler"], args: [{ name: ["Events", "Created"], … }] }`. Types that
 * aren't a (generic) name, such as unions or function types, have an empty `name` and keep their
 * normalised `text`.
 */
export interface TypeRef {
  /** The normalised type text. */
  text: string;
  /** Qualified name segments. */
  name: string[];
  /** Generic type arguments. */
  args: TypeRef[];
}

/** A decorator (TypeScript) or attribute (C#), with its arguments as source text. */
export interface AttributeFact {
  name: string;
  args: string[];
  range: Range;
}

export interface ParamFact {
  name: string;
  type?: TypeRef;
  /** e.g. `readonly`, `private` on a TypeScript parameter property; `ref`, `out` in C#. */
  modifiers: string[];
  optional?: boolean;
  rest?: boolean;
  attributes: AttributeFact[];
}

export interface SymbolFact {
  /** `${path}#${qualifiedName}`, plus `(${arity})` for overloads. */
  id: string;
  name: string;
  /** Name qualified by its enclosing declarations, e.g. `Outer.Inner.method`. */
  qualifiedName: string;
  kind: SymbolKind;
  range: Range;
  nameRange: Range;
  modifiers: string[];
  attributes: AttributeFact[];
  /** Base classes and implemented interfaces. */
  bases: TypeRef[];
  typeParams: string[];
  params?: ParamFact[];
  /** Return type; for a property, its declared type. */
  returns?: TypeRef;
  /** Nested declarations and members. */
  members: SymbolFact[];
  /** C# `partial` declarations, merged during binding resolution. */
  partial?: boolean;
  exported?: boolean;
  /** Body tokens, for rename similarity only; never cached or written to lock files. */
  bodyTokens?: string[];
}

export type ImportKind = "static" | "type" | "dynamic" | "require" | "reexport";

export interface ImportedName {
  /** The exported name, `default` or `*`. */
  name: string;
  /** The local name when it differs. */
  alias?: string;
}

export interface ImportFact {
  /** Module specifier as written, e.g. `./auth` or `System.Linq`. */
  module: string;
  kind: ImportKind;
  /** Imported names; empty for a side-effect import. */
  names: ImportedName[];
  range: Range;
}

export interface CallFact {
  /** Callee as written, whitespace removed, e.g. `console.log` or `this.repo.save`. */
  callee: string;
  /** Id of the innermost enclosing symbol; undefined at the top level. */
  enclosing?: string;
  range: Range;
}

export interface FileFacts {
  path: string;
  blobSha: string;
  /** Id of the adapter that produced the facts. */
  lang: string;
  /** Top-level declarations; nested ones are in `members`. */
  symbols: SymbolFact[];
  imports: ImportFact[];
  calls: CallFact[];
  /** Syntax errors; the facts around them are still extracted (see `parseErrorDiagnostics`). */
  parseErrors: Range[];
}

/** A language plug-in. `core` defines the interface; `cli` and `mcp` inject implementations. */
export interface LanguageAdapter {
  /** Language id, also its key under `languages` in `catspec.yaml`. */
  readonly id: string;
  /** File extensions with the dot, e.g. `.ts`. */
  readonly extensions: readonly string[];
  /** Loads the grammar and compiles the queries. Called once before `extract`. */
  load(): Promise<void>;
  /** Extracts the facts of one file. Pure, so the result can be cached by blob SHA. */
  extract(file: SourceFile): FileFacts;
  /** Normalises a type as written in this language. */
  normalizeType(text: string): TypeRef;
  /** The qualified name of a symbol of `file`. */
  qualify(symbol: SymbolFact, file: SourceFile): string;
}

/** One CS0901 warning per syntax error of the file, at the error's location. */
export function parseErrorDiagnostics(facts: FileFacts): Diagnostic[] {
  return facts.parseErrors.map(({ start, end }) =>
    createDiagnostic("CS0901", {
      codeLocation: {
        file: facts.path,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
      },
      message: "syntax error; the declarations before and after it are still read",
    }),
  );
}
