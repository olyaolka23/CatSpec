/** Package name. */
export const packageName = "@catspec/core";

export * from "./diagnostics.js";
export * from "./config.js";
export * from "./facts.js";
export {
  frontmatterLocation,
  parseSpecSource,
  splitFrontmatter,
  withFrontmatter,
  type SpecSource,
  type SplitSource,
} from "./frontmatter.js";
export * from "./spec-schema.js";
export * from "./spec-body.js";
export { readSpec, specLocation, type ReadSpecOptions, type Spec } from "./spec.js";
export { DependencyGraph } from "./graph.js";
export { loadSpecModel, SpecSet, type SpecModel } from "./load.js";
export {
  applyPatch,
  classifyOp,
  classifyPatch,
  editYaml,
  SpecEditError,
  type EditClass,
} from "./spec-editor.js";
export { formatPath } from "./schema-issues.js";
export { didYouMean, globMatcher, kebabCase, listFiles, LineIndex, toPosix } from "./util.js";
