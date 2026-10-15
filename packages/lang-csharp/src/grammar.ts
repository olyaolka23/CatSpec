/** The grammar WASM file shipped in `grammars/` (ADR-023), next to `src/` and `dist/`. */
export const CSHARP_GRAMMAR = new URL("../grammars/tree-sitter-c_sharp.wasm", import.meta.url);

/**
 * Where the grammar comes from (ADR-023). Part of the adapter version, so cached facts are
 * extracted again after a grammar upgrade.
 */
export const GRAMMAR_SOURCE = "tree-sitter-c-sharp@0.23.5";
