/** Tree-sitter queries of the C# adapter; each is compiled once per grammar. */

/** Every method invocation, with its callee. */
export const CALLS = {
  source: "(invocation_expression function: (_) @callee) @call",
  captures: ["call", "callee"],
} as const;

/** `using` directives, also inside namespaces. */
export const USINGS = {
  source: "(using_directive) @using",
  captures: ["using"],
} as const;
