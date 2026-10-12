/** Tree-sitter queries of the TypeScript adapter; each is compiled once per grammar. */

/** Every call, with its callee. */
export const CALLS = {
  source: "(call_expression function: (_) @callee) @call",
  captures: ["call", "callee"],
} as const;

/** Import statements and re-exports (`export … from "…"`). */
export const MODULE_STATEMENTS = {
  source: "(import_statement) @import\n(export_statement source: (_)) @reexport",
  captures: ["import", "reexport"],
} as const;
