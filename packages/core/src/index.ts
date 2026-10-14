/** Package name. */
export const packageName = "@catspec/core";

export * from "./diagnostics.js";
export * from "./config.js";
export * from "./facts.js";
export * from "./match.js";
export {
  codeLocation,
  formatLocation,
  SymbolTable,
  type Codebase,
  type SymbolEntry,
} from "./codebase.js";
export {
  resolveBinding,
  splitSymbol,
  type BindingResolution,
  type ResolvedBinding,
} from "./resolve.js";
export { attributeMatches, bindingItems, evaluateContract, signatureText } from "./contracts.js";
export { calleeNames, evaluateRule, importTargets, type TestRun } from "./rules.js";
export {
  checkCode,
  isEnforced,
  queryDiagnostics,
  runTestCommand,
  statusGate,
  testCommandArgs,
  type CheckMode,
  type CheckOptions,
  type CheckResult,
  type ItemResult,
  type StatusGate,
} from "./check.js";
export { coverage, type CoverageReport, type Ratio, type SpecCoverage } from "./coverage.js";
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
export {
  didYouMean,
  gitBlobSha,
  globMatcher,
  kebabCase,
  listFiles,
  LineIndex,
  toPosix,
} from "./util.js";
