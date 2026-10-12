/**
 * The Tree-sitter runtime (plan §D11.1, ADR-002, ADR-021, PBI `tree-sitter-runtime`):
 * `web-tree-sitter` is initialised once per process, each grammar WASM file is loaded once, and
 * each query is compiled once per grammar.
 */
import { fileURLToPath } from "node:url";

import { Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";

export type { Node, Tree } from "web-tree-sitter";

let initialised: Promise<void> | undefined;

/** Initialises `web-tree-sitter`. Safe to call many times; the work happens once. */
export function initTreeSitter(): Promise<void> {
  initialised ??= Parser.init().catch((error: unknown) => {
    initialised = undefined;
    throw error;
  });
  return initialised;
}

/** A capture of a typed query: `name` is one of the names the query was declared with. */
export interface Capture<Name extends string> {
  name: Name;
  node: Node;
}

/** One match of a typed query: the nodes of each capture, in document order. */
export interface Match<Name extends string> {
  patternIndex: number;
  captures: Capture<Name>[];
}

/** A compiled query whose captures are limited to the names it was declared with. */
export class TypedQuery<Name extends string> {
  constructor(private readonly query: Query) {}

  /** Every capture in `node`, in document order. */
  captures(node: Node): Capture<Name>[] {
    return this.query.captures(node).map(({ name, node }) => ({ name: name as Name, node }));
  }

  /** Every match in `node`, with its captures. */
  matches(node: Node): Match<Name>[] {
    return this.query.matches(node).map(({ patternIndex, captures }) => ({
      patternIndex,
      captures: captures.map(({ name, node }) => ({ name: name as Name, node })),
    }));
  }
}

/** A loaded grammar: parses text and compiles each query source once. */
export class Grammar {
  private readonly parser = new Parser();
  private readonly queries = new Map<string, Query>();
  private compiled = 0;

  constructor(readonly language: Language) {
    this.parser.setLanguage(language);
  }

  /** Number of queries compiled so far for this grammar. */
  get compiledQueries(): number {
    return this.compiled;
  }

  /** Parses `text`. The caller deletes the tree (`tree.delete()`), or uses `withTree`. */
  parse(text: string): Tree {
    const tree = this.parser.parse(text);
    if (!tree) throw new Error("Tree-sitter returned no tree");
    return tree;
  }

  /** Parses `text`, calls `use` with the tree and frees the tree afterwards. */
  withTree<T>(text: string, use: (tree: Tree) => T): T {
    const tree = this.parse(text);
    try {
      return use(tree);
    } finally {
      tree.delete();
    }
  }

  /**
   * The compiled query for `source`, compiled on first use. `names` lists every capture the
   * query may use; a capture outside it throws, so a typo in a `.scm` file fails at load time.
   */
  query<const Name extends string>(source: string, names: readonly Name[]): TypedQuery<Name> {
    let query = this.queries.get(source);
    if (!query) {
      query = new Query(this.language, source);
      this.compiled++;
      const unknown = query.captureNames.filter((name) => !names.includes(name as Name));
      if (unknown.length > 0) {
        query.delete();
        throw new Error(
          `query uses undeclared captures: ${unknown.map((n) => `@${n}`).join(", ")}`,
        );
      }
      this.queries.set(source, query);
    }
    return new TypedQuery<Name>(query);
  }
}

/** The error of a query that doesn't compile; `offset` is where in the query source. */
export class QuerySyntaxError extends Error {
  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(message);
    this.name = "QuerySyntaxError";
  }
}

/**
 * Compiles a user-written query (a `query` rule, plan §D6.3) for `grammar`, once per source.
 * Throws `QuerySyntaxError` when it doesn't compile.
 */
export function userQuery(grammar: Grammar, source: string): Query {
  let cached = userQueries.get(grammar);
  if (!cached) userQueries.set(grammar, (cached = new Map<string, Query | QuerySyntaxError>()));
  let query = cached.get(source);
  if (query instanceof QuerySyntaxError) throw query;
  if (!query) {
    try {
      query = new Query(grammar.language, source);
    } catch (error) {
      const failure = error as Error & { index?: number };
      const syntaxError = new QuerySyntaxError(
        failure.message,
        typeof failure.index === "number" ? failure.index : undefined,
      );
      cached.set(source, syntaxError);
      throw syntaxError;
    }
    cached.set(source, query);
  }
  return query;
}

const userQueries = new WeakMap<Grammar, Map<string, Query | QuerySyntaxError>>();

/** The nodes a user query reports: its `@hit` captures, else each match's first capture. */
export function queryHits(query: Query, node: Node): Node[] {
  const hits: Node[] = [];
  const hasHit = query.captureNames.includes("hit");
  for (const match of query.matches(node)) {
    const capture = hasHit
      ? match.captures.filter((c) => c.name === "hit")
      : match.captures.slice(0, 1);
    hits.push(...capture.map((c) => c.node));
  }
  return hits;
}

const grammars = new Map<string, Promise<Grammar>>();

/** Loads a grammar WASM file once per process (`web-tree-sitter` is initialised first). */
export function loadGrammar(wasm: string | URL): Promise<Grammar> {
  const path = typeof wasm === "string" ? wasm : fileURLToPath(wasm);
  let grammar = grammars.get(path);
  if (!grammar) {
    grammar = initTreeSitter()
      .then(() => Language.load(path))
      .then((language) => new Grammar(language));
    void grammar.catch(() => grammars.delete(path));
    grammars.set(path, grammar);
  }
  return grammar;
}
