/** The C# language adapter (plan §D11.2, feature F4 `csharp-language-support`). */
import {
  LineIndex,
  type FileFacts,
  type LanguageAdapter,
  type Range,
  type SourceFile,
  type SymbolFact,
  type TypeRef,
} from "@catspec/core";
import {
  loadGrammar,
  parseTypeRef,
  queryHits,
  QuerySyntaxError,
  userQuery,
  type Grammar,
} from "@catspec/lang";

import { extractFacts } from "./extract.js";
import { CSHARP_GRAMMAR, GRAMMAR_SOURCE } from "./grammar.js";
import { typeRefOf } from "./types.js";

/** Version of the facts this adapter extracts; change it when the extraction changes. */
const FACTS_VERSION = 2;

export class CSharpAdapter implements LanguageAdapter {
  readonly id = "csharp";
  readonly extensions = [".cs"] as const;
  readonly version = `csharp-facts-${FACTS_VERSION}+${GRAMMAR_SOURCE}`;

  private grammar?: Grammar;

  async load(): Promise<void> {
    this.grammar = await loadGrammar(CSHARP_GRAMMAR);
  }

  extract(file: SourceFile): FileFacts {
    const grammar = this.loaded();
    return grammar.withTree(file.text, (tree) => extractFacts(grammar, tree.rootNode, file));
  }

  /**
   * Normalises a type written in C# syntax, e.g. `global::System.String?` → `Nullable<String>`
   * (see `./types.ts`). Text the grammar can't read as a type is normalised as plain text.
   */
  normalizeType(text: string): TypeRef {
    if (!this.grammar) return parseTypeRef(text);
    return this.grammar.withTree(`class T { ${text} f; }`, (tree) => {
      if (tree.rootNode.hasError) return parseTypeRef(text);
      const type = tree.rootNode
        .descendantsOfType("variable_declaration")[0]
        ?.childForFieldName("type");
      return type ? typeRefOf(type) : parseTypeRef(text);
    });
  }

  qualify(symbol: SymbolFact): string {
    return symbol.qualifiedName;
  }

  /** Compiles a `query` rule's query (ADR-022). */
  checkQuery(query: string): string | undefined {
    try {
      userQuery(this.loaded(), query);
      return undefined;
    } catch (error) {
      if (error instanceof QuerySyntaxError) return error.message;
      throw error;
    }
  }

  runQuery(file: SourceFile, query: string): Range[] {
    const grammar = this.loaded();
    let compiled;
    try {
      compiled = userQuery(grammar, query);
    } catch (error) {
      if (error instanceof QuerySyntaxError) return [];
      throw error;
    }
    const lines = new LineIndex(file.text);
    return grammar.withTree(file.text, (tree) =>
      queryHits(compiled, tree.rootNode).map((node) => ({
        start: lines.position(node.startIndex),
        end: lines.position(node.endIndex),
      })),
    );
  }

  private loaded(): Grammar {
    if (!this.grammar) throw new Error("the C# adapter is not loaded; call load() first");
    return this.grammar;
  }
}
