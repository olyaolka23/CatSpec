/** The grammar WASM files shipped in `grammars/` (ADR-021), next to `src/` and `dist/`. */
export const TYPESCRIPT_GRAMMAR = new URL(
  "../grammars/tree-sitter-typescript.wasm",
  import.meta.url,
);
export const TSX_GRAMMAR = new URL("../grammars/tree-sitter-tsx.wasm", import.meta.url);

/**
 * Where the grammars come from (ADR-021). Part of the adapter version, so cached facts are
 * extracted again after a grammar upgrade.
 */
export const GRAMMAR_SOURCE = "tree-sitter-wasms@0.1.13";
