import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { initTreeSitter, loadGrammar } from "@catspec/lang";
import { describe, expect, it } from "vitest";

import { TSX_GRAMMAR, TYPESCRIPT_GRAMMAR } from "../src/index.js";

const SOURCE = `
import { IAuthService } from "./contracts";

export class AuthService implements IAuthService {
  login(user: string) {
    console.log(user);
  }

  validateToken(t: string): Promise<boolean> {
    return Promise.resolve(t.length > 0);
  }
}
`;

const CLASS_NAMES = "(class_declaration name: (type_identifier) @name)";

describe("tree-sitter runtime", () => {
  it("[AC-tree-sitter-runtime-1] parses a TypeScript file with WebAssembly only, no native build", async () => {
    // Everything that runs is WebAssembly: the runtime and the grammar.
    const runtime = createRequire(import.meta.resolve("@catspec/lang")).resolve(
      "web-tree-sitter/tree-sitter.wasm",
    );
    const wasmMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
    expect(readFileSync(runtime).subarray(0, 4)).toEqual(wasmMagic);
    expect(readFileSync(TYPESCRIPT_GRAMMAR).subarray(0, 4)).toEqual(wasmMagic);

    const grammar = await loadGrammar(TYPESCRIPT_GRAMMAR);
    const names = grammar.withTree(SOURCE, (tree) => {
      expect(tree.rootNode.type).toBe("program");
      expect(tree.rootNode.hasError).toBe(false);
      return grammar
        .query(CLASS_NAMES, ["name"])
        .captures(tree.rootNode)
        .map((capture) => capture.node.text);
    });
    expect(names).toEqual(["AuthService"]);
  });

  it("[AC-tree-sitter-runtime-2] compiles each query exactly once for 100 files of the same language", async () => {
    const grammar = await loadGrammar(TYPESCRIPT_GRAMMAR);
    const source = `${CLASS_NAMES}\n(method_definition name: (property_identifier) @method)`;
    const before = grammar.compiledQueries;

    let methods = 0;
    for (let i = 0; i < 100; i++) {
      const query = grammar.query(source, ["name", "method"]);
      grammar.withTree(SOURCE.replace("AuthService", `AuthService${i}`), (tree) => {
        methods += query.captures(tree.rootNode).filter((c) => c.name === "method").length;
      });
    }

    expect(grammar.compiledQueries - before).toBe(1);
    expect(methods).toBe(200);
  });

  it("parses TSX with the TSX grammar", async () => {
    const grammar = await loadGrammar(TSX_GRAMMAR);
    grammar.withTree("export const App = () => <div className='a'>{1}</div>;", (tree) => {
      expect(tree.rootNode.hasError).toBe(false);
    });
  });

  it("loads each grammar once and initialises the runtime once", async () => {
    await Promise.all([initTreeSitter(), initTreeSitter()]);
    const [a, b] = await Promise.all([
      loadGrammar(TYPESCRIPT_GRAMMAR),
      loadGrammar(TYPESCRIPT_GRAMMAR),
    ]);
    expect(a).toBe(b);
    expect(await loadGrammar(TSX_GRAMMAR)).not.toBe(a);
  });

  it("rejects a query that uses a capture it didn't declare", async () => {
    const grammar = await loadGrammar(TYPESCRIPT_GRAMMAR);
    expect(() =>
      grammar.query("(class_declaration name: (type_identifier) @nmae)", ["name"]),
    ).toThrow("query uses undeclared captures: @nmae");
  });

  it("returns typed matches with their captures", async () => {
    const grammar = await loadGrammar(TYPESCRIPT_GRAMMAR);
    const query = grammar.query(
      "(class_declaration name: (type_identifier) @class (class_heritage (implements_clause (type_identifier) @base)))",
      ["class", "base"],
    );
    const matches = grammar.withTree(SOURCE, (tree) =>
      query.matches(tree.rootNode).map((m) => m.captures.map((c) => `${c.name}=${c.node.text}`)),
    );
    expect(matches).toEqual([["class=AuthService", "base=IAuthService"]]);
  });
});
