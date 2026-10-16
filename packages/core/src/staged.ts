/**
 * The scope of `catspec check --staged` (plan §D11.3, §D11.7, §D13), PBI `staged-check`: the
 * commit being made, and only what it touches. A spec is checked when the commit changes its spec
 * file or lock file, a file its bindings resolved to (from the lock file), a file of its `file`
 * hints or `scope`, or declares a name one of its not-yet-located bindings looks for. The files
 * read are the changed files plus the files of those specs.
 */
import { SymbolTable } from "./codebase.js";
import { sortDiagnostics, type Diagnostic } from "./diagnostics.js";
import { parseErrorDiagnostics, type FileFacts } from "./facts.js";
import type { StagedChange } from "./git/git.js";
import type { SpecModel } from "./load.js";
import { lockedFiles, lockPathOf } from "./lock.js";
import { splitSymbol } from "./resolve.js";
import { globMatcher } from "./util.js";

export interface StagedScope {
  /** Paths the commit adds, changes or deletes (both sides of a rename). */
  changed: Set<string>;
  /** Ids of the specs to check, the architecture spec included when its rules apply. */
  specs: string[];
  /** Source files to read; undefined means every file (the architecture spec changed). */
  files?: Set<string>;
}

/**
 * The specs and files a staged check needs. `changedFacts` are the facts of the changed source
 * files; `paths` every file of the index.
 */
export function stagedScope(
  model: SpecModel,
  changes: readonly StagedChange[],
  changedFacts: readonly FileFacts[],
  paths: readonly string[],
): StagedScope {
  const changed = new Set(
    changes.flatMap((c) => (c.from === undefined ? [c.path] : [c.path, c.from])),
  );
  const changedList = [...changed];
  const declared = new SymbolTable(changedFacts);
  const touches = (globs: readonly string[]): boolean =>
    globs.length > 0 && changedList.some(globMatcher(globs));

  const specs: string[] = [];
  const files = new Set(changedList);
  for (const spec of model.specs.all()) {
    if (!spec.valid || spec.type === "architecture") continue;
    const lock = model.locks.get(spec.id);
    const located = spec.bindings.map((b) => ({ binding: b, files: lockedFiles(lock, b.id) }));
    const selected =
      changed.has(spec.file) ||
      changed.has(lockPathOf(spec)) ||
      located.some((l) => l.files.some((f) => changed.has(f))) ||
      spec.bindings.some((b) => b.file !== undefined && touches(b.file)) ||
      touches(spec.scope) ||
      located.some(
        (l) => l.files.length === 0 && declared.find(splitSymbol(l.binding.symbol).name).length > 0,
      );
    if (!selected) continue;
    specs.push(spec.id);
    for (const l of located) for (const f of l.files) files.add(f);
    const globs = [...spec.scope, ...spec.bindings.flatMap((b) => b.file ?? [])];
    if (globs.length > 0) {
      const match = globMatcher(globs);
      for (const path of paths) if (match(path)) files.add(path);
    }
  }

  const architecture = model.architecture?.valid ? model.architecture : undefined;
  const architectureChanged = architecture !== undefined && changed.has(architecture.file);
  if (architecture && (architectureChanged || changedFacts.length > 0)) specs.push(architecture.id);
  return { changed, specs, ...(architectureChanged ? {} : { files }) };
}

/**
 * The diagnostics a staged check reports: those of the checked specs, spec diagnostics of the
 * changed spec and lock files, syntax errors of the changed files, and architecture rule
 * violations in the changed files (in every file when the architecture spec itself changed).
 */
export function stagedDiagnostics(
  model: SpecModel,
  scope: StagedScope,
  checked: readonly Diagnostic[],
  changedFacts: readonly FileFacts[],
): Diagnostic[] {
  const architecture = model.architecture?.id;
  const selected = new Set(scope.specs);
  const inChanged = (d: Diagnostic): boolean =>
    (d.codeLocation !== undefined && scope.changed.has(d.codeLocation.file)) ||
    (d.specLocation !== undefined && scope.changed.has(d.specLocation.file));
  const kept = checked.filter((d) => {
    if (d.spec === undefined || !selected.has(d.spec)) return inChanged(d);
    if (d.spec !== architecture || scope.files === undefined || d.code.startsWith("CS01")) {
      return true;
    }
    return d.codeLocation !== undefined && scope.changed.has(d.codeLocation.file);
  });
  const extra = [
    ...model.diagnostics.filter(
      (d) => inChanged(d) || (d.spec === undefined && d.specLocation === undefined),
    ),
    ...changedFacts.flatMap(parseErrorDiagnostics),
  ];
  const seen = new Set(kept.map(key));
  for (const d of extra) {
    if (seen.has(key(d))) continue;
    seen.add(key(d));
    kept.push(d);
  }
  return sortDiagnostics(kept);
}

const key = (d: Diagnostic): string =>
  JSON.stringify([d.code, d.spec, d.specLocation, d.codeLocation, d.message]);
