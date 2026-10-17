/**
 * `catspec sync` and `catspec refactor` (plan §D10, §D11.4, §D11.8, ADR-013, ADR-016), PBIs
 * `sync-command`, `batch-rename-mapping` and `refactor-mode`: the git side of rename detection.
 *
 * The baseline is what the bindings resolved to before the change: the refactor baseline while a
 * refactor is in progress, else the lock files, with the old sources read from `HEAD`. The
 * current code is the working tree, or the git index with `--staged` (the hook). Changed files,
 * the old versions of changed and deleted files and git's file renames all come from comparing
 * the baseline revision with the current code.
 *
 * The refactor baseline lives in the runtime store, `<git-common-dir>/catspec/refactor.json`
 * (ADR-004): it is never committed, and every worktree of the clone sees it.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  baselineFromLock,
  baselineFromSymbol,
  bodyTokens,
  checkCode,
  compareStrings,
  createDiagnostic,
  detectRenames,
  globMatcher,
  hasLockFile,
  IndexProvider,
  loadSpecModel,
  lockPathOf,
  planSync,
  RevisionProvider,
  serializeLock,
  splitResolved,
  SymbolTable,
  WorkingTreeProvider,
  type BaselineSymbol,
  type CatspecConfig,
  type CheckResult,
  type Codebase,
  type Diagnostic,
  type Git,
  type RenameMap,
  type Severity,
  type SourceFile,
  type SourceProvider,
  type SpecModel,
  type SymbolEntry,
  type SymbolFact,
  type SyncPlan,
} from "@catspec/core";

import { loadCodebase } from "./codebase.js";

/** A refactor in progress (plan §D11.8): its scope, where it started, and the baseline. */
export interface RefactorBaseline {
  version: 1;
  /** The commit the refactor started from (`HEAD` then). */
  revision: string;
  /** The branch it started on; `--allow-wip` lets broken commits through only there. */
  branch?: string;
  /** Globs of the files in scope. */
  scope: string[];
  reason?: string;
  allowWip: boolean;
  startedAt: string;
  /** Every binding of the affected specs, as it resolved at `revision`. */
  symbols: BaselineSymbol[];
}

/** A usage problem of `sync` or `refactor` (exit code 2). */
export class SyncUsageError extends Error {}

const refactorFile = async (git: Git): Promise<string> =>
  join((await git.repository()).commonDir, "catspec", "refactor.json");

/** The refactor in progress, if any. A file that can't be read counts as none. */
export async function readRefactor(git: Git): Promise<RefactorBaseline | undefined> {
  const text = await readFile(await refactorFile(git), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<RefactorBaseline>;
    if (
      value.version !== 1 ||
      typeof value.revision !== "string" ||
      !Array.isArray(value.symbols)
    ) {
      return undefined;
    }
    return value as RefactorBaseline;
  } catch {
    return undefined;
  }
}

async function writeRefactor(git: Git, baseline: RefactorBaseline): Promise<void> {
  const file = await refactorFile(git);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

/** Ends the refactor in progress: deletes its baseline. */
export async function endRefactor(git: Git): Promise<boolean> {
  const file = await refactorFile(git);
  const existed = (await readFile(file).catch(() => undefined)) !== undefined;
  await rm(file, { force: true });
  return existed;
}

/**
 * `catspec refactor`: records the baseline of every binding whose declaration is in `scope`, as
 * the bindings resolve at `HEAD`.
 */
export async function startRefactor(
  root: string,
  config: CatspecConfig,
  git: Git,
  options: { scope?: string[]; reason?: string; allowWip?: boolean },
): Promise<RefactorBaseline> {
  const active = await readRefactor(git);
  if (active) {
    throw new SyncUsageError(
      `a refactor is already in progress (started ${active.startedAt}${active.branch ? ` on ${active.branch}` : ""}); ` +
        "finish it with `catspec sync --apply` or drop it with `catspec refactor abort`",
    );
  }
  const revision = await git.commitId("HEAD");
  if (revision === undefined) throw new SyncUsageError("refactor needs a commit to start from");
  const branch = await git.currentBranch();
  const scope = options.scope && options.scope.length > 0 ? options.scope : ["**"];
  const inScope = globMatcher(scope);
  const head = new RevisionProvider(git, revision);
  const model = await loadSpecModel(root, config, head);
  const codebase = await loadCodebase(root, config, { source: head });
  const result = await checkCode(model, codebase);
  const symbols: BaselineSymbol[] = [];
  for (const spec of result.checked) {
    if (!hasLockFile(spec)) continue;
    for (const [bindingId, resolved] of result.resolved.get(spec.id) ?? []) {
      if (!resolved.files.some(inScope)) continue;
      symbols.push(
        baselineFromSymbol(spec.id, bindingId, resolved, await codebase.source(resolved.file.path)),
      );
    }
  }
  const baseline: RefactorBaseline = {
    version: 1,
    revision,
    ...(branch !== undefined ? { branch } : {}),
    scope,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    allowWip: options.allowWip ?? config.refactor.allow_wip,
    startedAt: new Date().toISOString(),
    symbols,
  };
  await writeRefactor(git, baseline);
  return baseline;
}

/** Reads a rename map file (`--map`): `{ "symbols": {…}, "namespaces": {…}, "paths": {…} }`. */
export async function readRenameMap(file: string): Promise<RenameMap> {
  const text = await readFile(file, "utf8").catch(() => {
    throw new SyncUsageError(`--map: no such file: ${file}`);
  });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SyncUsageError(`--map: ${file} is not valid JSON: ${(error as Error).message}`);
  }
  const expected =
    '(expected { "symbols": {…}, "namespaces": {…}, "paths": {…} } with string values)';
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isRecord(value)) throw new SyncUsageError(`--map: ${file}: not an object ${expected}`);
  const map: RenameMap = {};
  for (const [key, section] of Object.entries(value)) {
    if (key !== "symbols" && key !== "namespaces" && key !== "paths") {
      throw new SyncUsageError(`--map: ${file}: unknown key "${key}" ${expected}`);
    }
    if (!isRecord(section) || !Object.values(section).every((v) => typeof v === "string")) {
      throw new SyncUsageError(`--map: ${file}: "${key}" must map names to names ${expected}`);
    }
    map[key] = section as Record<string, string>;
  }
  return map;
}

export interface SyncRun {
  model: SpecModel;
  codebase: Codebase;
  result: CheckResult;
  plan: SyncPlan;
  /** The refactor in progress, if any. */
  refactor?: RefactorBaseline;
  /** Baseline bindings that no longer resolve. */
  broken: BaselineSymbol[];
  /** Where the specs and code were read from. */
  source: SourceProvider;
}

export interface SyncRunOptions {
  /** Read the git index instead of the working tree (`--staged`, the hook). */
  staged?: boolean;
  map?: RenameMap;
  updateMentions?: boolean;
  mappedSeverity?: Severity;
  /** A check already made on the same source, reused (the hook). */
  checked?: { model: SpecModel; codebase: Codebase; result: CheckResult };
  /** Ignore the refactor in progress (the hook outside its grouping). */
  refactor?: RefactorBaseline | null;
}

/** Finds the renames of the repository at `root` and plans the spec edits (`catspec sync`). */
export async function planRepositorySync(
  root: string,
  config: CatspecConfig,
  git: Git,
  options: SyncRunOptions = {},
): Promise<SyncRun> {
  const source: SourceProvider = options.staged
    ? new IndexProvider(git)
    : new WorkingTreeProvider(root);
  const model = options.checked?.model ?? (await loadSpecModel(root, config, source));
  const codebase = options.checked?.codebase ?? (await loadCodebase(root, config, { source }));
  const result = options.checked?.result ?? (await checkCode(model, codebase));
  const refactor =
    options.refactor === null ? undefined : (options.refactor ?? (await readRefactor(git)));
  const revision = refactor?.revision ?? (await git.commitId("HEAD"));

  // What the bindings resolved to before: the refactor baseline, or the lock files.
  const baseline: BaselineSymbol[] = refactor
    ? refactor.symbols
    : result.checked.flatMap((spec) => {
        const lock = model.locks.get(spec.id);
        if (!lock || !hasLockFile(spec)) return [];
        return spec.bindings.flatMap((b) => {
          const entry = lock.symbols[b.id];
          return entry ? [baselineFromLock(spec.id, b.id, entry)] : [];
        });
      });
  const broken = baseline.filter((b) => {
    const spec = model.specs.get(b.spec);
    const resolved = result.resolved.get(b.spec);
    return (
      spec !== undefined &&
      resolved !== undefined &&
      spec.bindings.some((binding) => binding.id === b.binding) &&
      !resolved.has(b.binding)
    );
  });

  // Bindings that resolve, but no longer in their file hint: the file moved.
  const movedHints = new Map<string, Map<string, SymbolEntry>>();
  for (const spec of result.checked) {
    for (const [bindingId, resolved] of result.resolved.get(spec.id) ?? []) {
      const hint = resolved.binding.file;
      if (!hint || resolved.parts.length !== 1) continue;
      const matches = globMatcher(hint);
      if (resolved.files.some((f) => hint.includes(f) || matches(f))) continue;
      const hints = movedHints.get(spec.id) ?? new Map<string, SymbolEntry>();
      hints.set(bindingId, { symbol: resolved.symbol, file: resolved.file });
      movedHints.set(spec.id, hints);
    }
  }

  let changed = new Set(codebase.files.map((f) => f.path));
  let before: Codebase | undefined;
  const renames = new Map<string, string>();
  if (broken.length > 0 && revision !== undefined) {
    const old = new Map((await git.lsTree(revision)).map((e) => [e.path, e.blobSha]));
    const now = new Map(codebase.files.map((f) => [f.path, f.blobSha]));
    changed = new Set(
      codebase.files.filter((f) => old.get(f.path) !== f.blobSha).map((f) => f.path),
    );
    const oldSide = new Set([...old.keys()].filter((p) => now.get(p) !== old.get(p)));
    before = await loadCodebase(root, config, {
      source: new RevisionProvider(git, revision),
      only: (p) => oldSide.has(p),
    });
    for (const change of await git.changesSince(revision, { cached: options.staged === true })) {
      if (change.status === "R" && change.from !== undefined) renames.set(change.from, change.path);
    }
    // Without a refactor baseline, the old bodies come from the baseline revision.
    if (!refactor) {
      for (const b of broken) {
        const { file, qualifiedName } = splitResolved(b.resolved);
        const facts = before.files.find((f) => f.path === file);
        const symbol = facts && findSymbol(facts.symbols, qualifiedName, b.shape.kind);
        if (symbol) b.tokens = bodyTokens(await before.source(file), symbol);
      }
    }
  }

  const taken = new Set<string>();
  for (const resolved of result.resolved.values()) {
    for (const r of resolved.values()) {
      for (const part of r.parts) taken.add(`${part.file.path}#${part.symbol.id}`);
    }
  }
  const sources = new Map<string, Promise<SourceFile>>();
  const sourceOf = (path: string): Promise<SourceFile> => {
    let file = sources.get(path);
    if (!file) sources.set(path, (file = codebase.source(path)));
    return file;
  };
  const report = await detectRenames({
    broken,
    table: new SymbolTable(codebase.files),
    changed,
    before: before?.files ?? [],
    renames,
    ...(options.map ? { map: options.map } : {}),
    threshold: config.heal.threshold,
    tokens: async (entry) => bodyTokens(await sourceOf(entry.file.path), entry.symbol),
    taken,
  });
  const plan = planSync(model, report, {
    ...(options.mappedSeverity ? { mappedSeverity: options.mappedSeverity } : {}),
    ...(options.updateMentions ? { updateMentions: true } : {}),
    ...(options.map?.paths ? { paths: options.map.paths } : {}),
    movedHints,
  });
  return {
    model,
    codebase,
    result,
    plan,
    ...(refactor ? { refactor } : {}),
    broken,
    source,
  };
}

function findSymbol(
  symbols: readonly SymbolFact[],
  qualifiedName: string,
  kind: string,
): SymbolFact | undefined {
  for (const s of symbols) {
    if (s.qualifiedName === qualifiedName && s.kind === kind) return s;
    const nested = findSymbol(s.members, qualifiedName, kind);
    if (nested) return nested;
  }
  return undefined;
}

export interface AppliedSync {
  /** Files written. */
  written: string[];
  /** Files written and staged. */
  staged: string[];
}

/**
 * Writes the planned spec edits and moved lock entries (`sync --apply`). A file is staged when it
 * had no unstaged changes before (its index content equals its working-tree content), so a
 * partially staged spec is never staged whole. With `staged`, the edits were made on the index
 * version, so a file with unstaged changes is refused.
 */
export async function applySync(
  root: string,
  run: SyncRun,
  git: Git,
  options: { staged?: boolean } = {},
): Promise<AppliedSync> {
  const index = new IndexProvider(git);
  const files: { path: string; text: string; read: string }[] = [];
  for (const edit of run.plan.edits) {
    files.push({ path: edit.spec.file, text: edit.text, read: edit.spec.source.text });
  }
  for (const [specId, lock] of run.plan.locks) {
    const spec = run.model.specs.get(specId);
    if (!spec) continue;
    const path = lockPathOf(spec);
    files.push({ path, text: serializeLock(lock), read: run.model.lockTexts.get(path) ?? "" });
  }
  const plans: { path: string; text: string; stage: boolean }[] = [];
  for (const file of files) {
    const worktree = await readFile(join(root, file.path), "utf8").catch(() => undefined);
    if (options.staged && worktree !== undefined && worktree !== file.read) {
      throw new SyncUsageError(
        `${file.path} has unstaged changes; stage them, or run \`catspec sync --apply\` without --staged`,
      );
    }
    const indexed = (await index.read(file.path))?.toString("utf8");
    plans.push({
      path: file.path,
      text: file.text,
      stage: options.staged === true || indexed === worktree,
    });
  }
  const written: string[] = [];
  const staged: string[] = [];
  for (const plan of plans) {
    const target = join(root, plan.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, plan.text, "utf8");
    written.push(plan.path);
    if (plan.stage) staged.push(plan.path);
  }
  await git.add(staged);
  return { written: written.sort(compareStrings), staged: staged.sort(compareStrings) };
}

/** Binding, drift and ratchet diagnostics: what a large refactor groups into one CS0215. */
const isBindingProblem = (d: Diagnostic): boolean =>
  d.code.startsWith("CS02") || d.code === "CS0300" || d.code === "CS0301";

export interface HookRenames {
  diagnostics: Diagnostic[];
  /** Spec and lock files the hook healed and staged (`heal.mode: auto`). */
  healed: string[];
  /** The patches to show: CS0210 diagnostics with their edit's before and after text. */
  patches: { file: string; before: string; after: string }[];
}

/**
 * The renames part of the pre-commit hook (plan §D11.4, §D11.8): a large refactor (more than
 * `refactor.detect_threshold` broken bindings, or any during a refactor) becomes one CS0215;
 * otherwise each broken binding whose new declaration is found becomes CS0210 with its patch, or
 * CS0216 when it is ambiguous. With `heal.mode: auto` the patches are applied and staged, and
 * `recheck` runs the check again.
 */
export async function hookRenames(
  root: string,
  config: CatspecConfig,
  git: Git,
  checked: { model: SpecModel; codebase: Codebase; result: CheckResult; diagnostics: Diagnostic[] },
  recheck: () => Promise<{ diagnostics: Diagnostic[] }>,
): Promise<HookRenames> {
  const { model, result } = checked;
  // Bindings that resolved before (they have a lock entry) and don't now. Only then is the
  // refactor baseline read, so a commit without broken bindings costs nothing more.
  const unresolved: { spec: string; binding: string; locked: boolean }[] = [];
  for (const spec of result.checked) {
    if (!hasLockFile(spec)) continue;
    const lock = model.locks.get(spec.id);
    const resolved = result.resolved.get(spec.id);
    for (const b of spec.bindings) {
      if (!resolved?.has(b.id)) {
        unresolved.push({
          spec: spec.id,
          binding: b.id,
          locked: lock?.symbols[b.id] !== undefined,
        });
      }
    }
  }
  const refactor = unresolved.length > 0 ? await readRefactor(git) : undefined;
  const inBaseline = new Set(refactor?.symbols.map((s) => `${s.spec}\u0000${s.binding}`) ?? []);
  const broken = unresolved
    .filter((b) => b.locked || inBaseline.has(`${b.spec}\u0000${b.binding}`))
    .map(({ spec, binding }) => ({ spec, binding }));
  const unchanged = { diagnostics: checked.diagnostics, healed: [], patches: [] };
  if (broken.length === 0) return unchanged;

  const grouped =
    refactor !== undefined
      ? broken.filter((b) => inBaseline.has(`${b.spec}\u0000${b.binding}`))
      : broken.length > config.refactor.detect_threshold
        ? broken
        : [];
  if (grouped.length > 0) {
    const specs = new Set(
      refactor ? refactor.symbols.map((s) => s.spec) : grouped.map((b) => b.spec),
    );
    const removed = checked.diagnostics.filter(
      (d) => d.spec !== undefined && specs.has(d.spec) && isBindingProblem(d),
    );
    const kept = checked.diagnostics.filter((d) => !removed.includes(d));
    const branch = refactor ? await git.currentBranch() : undefined;
    const wip = refactor !== undefined && refactor.allowWip && branch === refactor.branch;
    const severity: Severity = wip
      ? "warning"
      : removed.some((d) => d.severity === "error") || refactor !== undefined
        ? "error"
        : "warning";
    const specCount = new Set(grouped.map((b) => b.spec)).size;
    const what = `${grouped.length} binding${grouped.length === 1 ? "" : "s"} unresolved in ${specCount} spec${specCount === 1 ? "" : "s"}`;
    const message = refactor
      ? `refactor in progress${refactor.reason ? ` (${refactor.reason})` : ""}: ${what}; run \`catspec sync\` to see the mapping and \`catspec sync --apply\` to finish` +
        (wip
          ? ` (work in progress allowed on ${refactor.branch})`
          : refactor.allowWip
            ? `; work in progress is allowed only on ${refactor.branch ?? "the branch the refactor started on"}`
            : "")
      : `large refactor: ${what} in this commit (more than refactor.detect_threshold, ${config.refactor.detect_threshold}); run \`catspec sync\` to see the mapping and \`catspec sync --apply\` to update every spec at once`;
    kept.push(
      createDiagnostic("CS0215", {
        severity,
        message,
        expected: "every binding resolves",
        actual: grouped.map((b) => `${b.spec}: ${b.binding}`),
        suggestions: [
          {
            message:
              "run `catspec sync` (dry run), then `catspec sync --apply [--map renames.json]`",
          },
        ],
      }),
    );
    return { diagnostics: kept, healed: [], patches: [] };
  }

  if (config.heal.mode === "off") return unchanged;
  const run = await planRepositorySync(root, config, git, {
    staged: true,
    checked,
    refactor: null,
  });
  const { plan } = run;
  let diagnostics = checked.diagnostics;
  const replaced = (codes: Diagnostic[]): Diagnostic[] => {
    let out = diagnostics;
    for (const d of codes) {
      const targets = out.filter(
        (x) =>
          x.spec === d.spec &&
          x.bindingId === d.bindingId &&
          (x.code === "CS0201" || x.code === "CS0202" || x.code === "CS0301"),
      );
      if (targets.length === 0) continue;
      const severity: Severity = targets.some((t) => t.severity === "error")
        ? "error"
        : targets.some((t) => t.severity === "warning")
          ? "warning"
          : "info";
      out = [...out.filter((x) => !targets.includes(x)), { ...d, severity }];
    }
    return out;
  };
  const renamed = plan.diagnostics.filter(
    (d) => d.code === "CS0210" && d.bindingId !== undefined && d.item,
  );
  const ambiguous = plan.diagnostics.filter((d) => d.code === "CS0216");
  diagnostics = replaced([...renamed, ...ambiguous]);

  const patches = plan.edits.map((e) => ({
    file: e.spec.file,
    before: e.spec.source.text,
    after: e.text,
  }));
  if (config.heal.mode !== "auto" || plan.edits.length === 0 || renamed.length === 0) {
    return { diagnostics, healed: [], patches };
  }
  // heal.mode auto: apply the location edits, stage them, and check again.
  let applied: AppliedSync;
  try {
    applied = await applySync(root, run, git, { staged: true });
  } catch (error) {
    if (!(error instanceof SyncUsageError)) throw error;
    return {
      diagnostics: [
        ...diagnostics,
        createDiagnostic("CS0210", {
          severity: "info",
          message: `not healed automatically: ${error.message}`,
        }),
      ],
      healed: [],
      patches,
    };
  }
  const again = await recheck();
  return {
    diagnostics: [
      ...again.diagnostics,
      ...renamed.map((d) => ({ ...d, severity: "info" as const, message: `healed: ${d.message}` })),
    ],
    healed: applied.staged,
    patches,
  };
}
