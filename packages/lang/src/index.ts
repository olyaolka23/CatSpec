/** Package name. */
export const packageName = "@catspec/lang";

export {
  DiskFactsCache,
  FactsProvider,
  factsCacheFor,
  MemoryFactsCache,
  type FactsCache,
} from "./cache.js";
export { AdapterRegistry, type LanguageFiles } from "./registry.js";
export { repositoryFacts, SymbolIndex, type SymbolHit } from "./symbol-index.js";
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
