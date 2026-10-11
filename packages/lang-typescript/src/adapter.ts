/** The TypeScript/TSX language adapter (plan §D11.2, PBI `typescript-adapter`). */
import type { FileFacts, LanguageAdapter, SourceFile, SymbolFact, TypeRef } from "@catspec/core";
import { loadGrammar, parseTypeRef, type Grammar } from "@catspec/lang";

import { extractFacts, typeRefOf } from "./extract.js";
import { GRAMMAR_SOURCE, TSX_GRAMMAR, TYPESCRIPT_GRAMMAR } from "./grammar.js";

/** Version of the facts this adapter extracts; change it when the extraction changes. */
const FACTS_VERSION = 1;

export class TypeScriptAdapter implements LanguageAdapter {
  readonly id = "typescript";
  readonly extensions = [".ts", ".tsx", ".mts", ".cts"] as const;
  readonly version = `typescript-facts-${FACTS_VERSION}+${GRAMMAR_SOURCE}`;

  private typescript?: Grammar;
  private tsx?: Grammar;

  async load(): Promise<void> {
    [this.typescript, this.tsx] = await Promise.all([
      loadGrammar(TYPESCRIPT_GRAMMAR),
      loadGrammar(TSX_GRAMMAR),
    ]);
  }

  extract(file: SourceFile): FileFacts {
    const grammar = this.grammarFor(file.path);
    return grammar.withTree(file.text, (tree) => extractFacts(grammar, tree.rootNode, file));
  }

  /** Normalises a type written in TypeScript syntax, e.g. `readonly string[]` → `Array<string>`. */
  normalizeType(text: string): TypeRef {
    if (!this.typescript) return parseTypeRef(text);
    return this.typescript.withTree(`type T = ${text};`, (tree) => {
      const value = tree.rootNode.namedChildren[0]?.childForFieldName("value");
      return value && !tree.rootNode.hasError ? typeRefOf(value) : parseTypeRef(text);
    });
  }

  qualify(symbol: SymbolFact): string {
    return symbol.qualifiedName;
  }

  private grammarFor(path: string): Grammar {
    const grammar = path.endsWith(".tsx") ? this.tsx : this.typescript;
    if (!grammar) throw new Error("the TypeScript adapter is not loaded; call load() first");
    return grammar;
  }
}
