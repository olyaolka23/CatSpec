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
  inModule,
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
export {
  Git,
  GitError,
  GitUnavailableError,
  type StagedChange,
  type TreeEntry,
} from "./git/git.js";
export {
  IndexProvider,
  RevisionProvider,
  WorkingTreeProvider,
  type SourceEntry,
  type SourceProvider,
} from "./git/providers.js";
export {
  applyLock,
  fingerprintOf,
  hasLockFile,
  itemHashes,
  lockedFiles,
  lockPathOf,
  nextLock,
  parseLock,
  serializeLock,
  shapeOf,
  specHash,
  type LockCheckOptions,
  type LockedSymbol,
  type LockFile,
  type NextLockOptions,
  type Shape,
} from "./lock.js";
export { stagedDiagnostics, stagedScope, type StagedScope } from "./staged.js";
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
export {
  architectureMatcher,
  isArchitectureSpecText,
  loadSpecModel,
  plainAdrIds,
  sameAdrId,
  SpecSet,
  type SpecModel,
} from "./load.js";
export {
  applyPatch,
  classifyOp,
  classifyPatch,
  editYaml,
  readYaml,
  SpecEditError,
  type EditClass,
} from "./spec-editor.js";
export { formatPath } from "./schema-issues.js";
export {
  didYouMean,
  gitBlobSha,
  globMatcher,
  isListedPath,
  kebabCase,
  listFiles,
  LineIndex,
  relativePosix,
  toPosix,
} from "./util.js";
export {
  baselineFromLock,
  baselineFromSymbol,
  bodyTokens,
  detectRenames,
  jaccard,
  memberNames,
  nameFreeFingerprint,
  renameScore,
  splitResolved,
  tokenSimilarity,
  type Ambiguity,
  type BaselineSymbol,
  type Evidence,
  type Lost,
  type Mapping,
  type RenameInput,
  type RenameMap,
  type RenameReport,
  type ScoredCandidate,
} from "./rename.js";
export {
  editPatch,
  planSync,
  rewriteSymbol,
  type SpecEdit,
  type SyncOptions,
  type SyncPlan,
} from "./sync.js";
export * from "./workflow/schema.js";
export * from "./workflow/engine.js";
export * from "./workflow/doctor.js";
export * from "./workflow/format.js";
