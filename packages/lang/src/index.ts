/** Package name. */
export const packageName = "@catspec/lang";

export { AdapterRegistry, type LanguageFiles } from "./registry.js";
export {
  isSegmentSuffix,
  nameMatches,
  normalizeTypeText,
  parseTypeRef,
  typeMatches,
} from "./types.js";
