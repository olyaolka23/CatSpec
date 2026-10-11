/** Package name. */
export const packageName = "@catspec/lang";

export { AdapterRegistry, type LanguageFiles } from "./registry.js";
export {
  Grammar,
  initTreeSitter,
  loadGrammar,
  TypedQuery,
  type Capture,
  type Match,
  type Node,
  type Tree,
} from "./tree-sitter.js";
export {
  isSegmentSuffix,
  nameMatches,
  normalizeTypeText,
  parseTypeRef,
  typeMatches,
} from "./types.js";
