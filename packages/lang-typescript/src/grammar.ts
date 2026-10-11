/** The grammar WASM files shipped in `grammars/` (ADR-021), next to `src/` and `dist/`. */
export const TYPESCRIPT_GRAMMAR = new URL(
  "../grammars/tree-sitter-typescript.wasm",
  import.meta.url,
);
export const TSX_GRAMMAR = new URL("../grammars/tree-sitter-tsx.wasm", import.meta.url);
