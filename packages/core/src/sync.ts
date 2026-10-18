/**
 * `catspec sync` (plan §D10, §D11.4, §D11.6, §D11.8, ADR-008), PBIs `sync-command` and
 * `batch-rename-mapping`: turns a rename report into spec edits, lock-file moves and diagnostics.
 *
 * Edits are location-only `SpecPatch`es: a binding's `symbol` and `file` values, never a contract
 * field (every patch is checked with `classifyPatch`). Backticked mentions of old names in the
 * spec body are reported as info and rewritten only with `updateMentions`. Lock entries move to
 * the new declaration, so `satisfied` (the ratchet) survives; a shape that changed only by its
 * name is accepted, any other change stays drift (CS0300).
 */
import { posix } from "node:path";

import type { SymbolEntry } from "./codebase.js";
import { codeLocation, formatLocation } from "./codebase.js";
import {
  createDiagnostic,
  type Diagnostic,
  type PatchOp,
  type Severity,
  type SpecPatch,
} from "./diagnostics.js";
import type { SpecModel } from "./load.js";
import { fingerprintOf, shapeOf, type LockedSymbol, type LockFile } from "./lock.js";
import {
  nameFreeFingerprint,
  splitResolved,
  type Ambiguity,
  type BaselineSymbol,
  type Lost,
  type Mapping,
  type RenameReport,
  wordPattern,
} from "./rename.js";
import { inModule, splitSymbol } from "./resolve.js";
import { applyPatch, classifyPatch, readYaml, SpecEditError } from "./spec-editor.js";
import type { Binding } from "./spec-schema.js";
import { specLocation, type Spec } from "./spec.js";
import { globMatcher, listOf } from "./util.js";

/** The edit of one spec file. */
export interface SpecEdit {
  spec: Spec;
  /** Frontmatter operations (location fields only). */
  ops: PatchOp[];
  /** The file text after the edit. */
  text: string;
}

export interface SyncPlan {
  report: RenameReport;
  edits: SpecEdit[];
  /** Lock files with entries moved to the new declarations, by spec id (only specs with a lock). */
  locks: Map<string, LockFile>;
  /** CS0210 for each mapped binding, CS0216 ambiguous, CS0217 lost, CS0210 info for mentions. */
  diagnostics: Diagnostic[];
}

export interface SyncOptions {
  /** Severity of the CS0210 of a mapped binding (default info: `sync` fixes it). */
  mappedSeverity?: Severity;
  /** Rewrite backticked mentions of old names in the spec bodies (`--update-mentions`). */
  updateMentions?: boolean;
  /** The `paths` of the rename map, to rewrite `file` globs. */
  paths?: Record<string, string>;
  /**
   * Bindings that still resolve, but outside their `file` hint (a moved file): their hint is
   * updated too. By spec id, then binding id.
   */
  movedHints?: ReadonlyMap<string, ReadonlyMap<string, SymbolEntry>>;
}

const EVIDENCE: Record<Mapping["evidence"], string> = {
  map: "rename map",
  moved: "moved",
  prefix: "prefix rule",
  "file-rename": "file renamed",
  fingerprint: "same shape",
  similarity: "similarity",
};

/** Plans the spec edits, lock moves and diagnostics of a rename report. */
export function planSync(
  model: SpecModel,
  report: RenameReport,
  options: SyncOptions = {},
): SyncPlan {
  const diagnostics: Diagnostic[] = [];
  const ops = new Map<Spec, PatchOp[]>();
  const renamed = new Map<Spec, { from: string[]; to: string }[]>();
  const locks = new Map<string, LockFile>();
  const addOps = (spec: Spec, more: PatchOp[]): void => {
    if (more.length > 0) ops.set(spec, [...(ops.get(spec) ?? []), ...more]);
  };

  for (const mapping of report.mapped) {
    for (const old of mapping.bindings) {
      const spec = model.specs.get(old.spec);
      const binding = spec?.bindings.find((b) => b.id === old.binding);
      if (!spec || !binding) continue;
      const bindingOps = relocate(spec, binding, old, mapping.target, options.paths);
      addOps(spec, bindingOps);
      const oldName = splitResolved(old.resolved).qualifiedName || old.shape.name;
      renamed.set(spec, [
        ...(renamed.get(spec) ?? []),
        {
          from: [...new Set([oldName, splitSymbol(binding.symbol).name])],
          to: mapping.target.symbol.qualifiedName,
        },
      ]);
      moveLock(model, locks, old, mapping.target, mapping.files);
      const how =
        `${EVIDENCE[mapping.evidence]}${mapping.score !== undefined ? `, score ${mapping.score.toFixed(2)}` : ""}` +
        (mapping.detail ? `: ${mapping.detail}` : "");
      diagnostics.push(
        createDiagnostic("CS0210", {
          spec: spec.id,
          specLocation: specLocation(spec.source, ["bindings", binding.index, "symbol"]),
          codeLocation: codeLocation(mapping.target.file.path, mapping.target.symbol.nameRange),
          bindingId: binding.id,
          item: `binding:${binding.id}`,
          severity: options.mappedSeverity ?? "info",
          message: `binding "${binding.id}": ${oldName} is now ${mapping.target.symbol.qualifiedName} at ${formatLocation(mapping.target.file.path, mapping.target.symbol.nameRange)} (${how})`,
          expected: binding.symbol,
          actual: `${mapping.target.file.path}#${mapping.target.symbol.qualifiedName}`,
          suggestions: [
            {
              message: "run `catspec sync --apply` to update the spec",
              patch: { file: spec.file, ops: bindingOps },
            },
          ],
        }),
      );
    }
  }

  for (const [specId, hints] of options.movedHints ?? []) {
    const spec = model.specs.get(specId);
    if (!spec) continue;
    for (const [bindingId, entry] of hints) {
      const binding = spec.bindings.find((b) => b.id === bindingId);
      if (!binding) continue;
      const hintOps = rewriteHints(spec, binding, undefined, entry.file.path, options.paths);
      if (hintOps.length === 0) continue;
      addOps(spec, hintOps);
      diagnostics.push(
        createDiagnostic("CS0210", {
          spec: spec.id,
          specLocation: specLocation(spec.source, ["bindings", binding.index, "file"]),
          codeLocation: codeLocation(entry.file.path, entry.symbol.nameRange),
          bindingId: binding.id,
          severity: "info",
          message: `binding "${binding.id}": ${binding.symbol} moved to ${entry.file.path}, outside its file hint (moved, score 1.00)`,
          suggestions: [
            {
              message: "run `catspec sync --apply` to update the hint",
              patch: { file: spec.file, ops: hintOps },
            },
          ],
        }),
      );
    }
  }

  for (const ambiguity of report.ambiguous) diagnostics.push(...ambiguous(model, ambiguity));
  for (const lost of report.lost) diagnostics.push(...lostDiagnostics(model, lost));

  const edits: SpecEdit[] = [];
  for (const spec of model.specs.byFile.values()) {
    const specOps = ops.get(spec) ?? [];
    const mentions = mentionsOf(spec, renamed.get(spec) ?? []);
    for (const m of mentions) {
      diagnostics.push(
        createDiagnostic("CS0210", {
          spec: spec.id,
          specLocation: { file: spec.file, line: m.line, column: m.column },
          severity: "info",
          message: options.updateMentions
            ? `the body mentions \`${m.text}\`; rewritten to \`${m.replacement}\``
            : `the body mentions \`${m.text}\`, now \`${m.replacement}\`; \`catspec sync --apply --update-mentions\` rewrites it`,
        }),
      );
    }
    if (specOps.length === 0 && !(options.updateMentions && mentions.length > 0)) continue;
    if (specOps.length > 0 && classifyPatch(specOps, spec.source) !== "location") {
      throw new SpecEditError(`${spec.file}: a sync edit would change the contract (ADR-008)`);
    }
    let text = applyPatch(spec.source, specOps);
    if (options.updateMentions && mentions.length > 0) text = rewriteMentions(text, spec, mentions);
    edits.push({ spec, ops: specOps, text });
  }
  return { report, edits, locks, diagnostics };
}

/** The ops that point `binding` at `target`: its `symbol`, and its `file` hint if it has one. */
function relocate(
  spec: Spec,
  binding: Binding,
  old: BaselineSymbol,
  target: SymbolEntry,
  paths: Record<string, string> | undefined,
): PatchOp[] {
  const oldFile = splitResolved(old.resolved).file;
  const symbol = rewriteSymbol(binding.symbol, old, target);
  const out: PatchOp[] = [];
  if (symbol !== binding.symbol) {
    out.push({ op: "set", path: ["bindings", binding.index, "symbol"], value: symbol });
  }
  out.push(...rewriteHints(spec, binding, oldFile, target.file.path, paths));
  return out;
}

/**
 * The binding's `symbol` for the new declaration, written the way it was: as many name segments
 * as before (all of them when it was fully qualified), and the module path when it had one.
 */
export function rewriteSymbol(written: string, old: BaselineSymbol, target: SymbolEntry): string {
  const { module, name } = splitSymbol(written);
  const before = (splitResolved(old.resolved).qualifiedName || old.shape.name).split(".");
  const after = target.symbol.qualifiedName.split(".");
  const count = name.split(".").length;
  const newName = count >= before.length ? after.join(".") : after.slice(-count).join(".");
  if (module === undefined) return newName;
  const oldFile = splitResolved(old.resolved).file;
  const newModule = inModule(target.file.path, module)
    ? module
    : rewriteModule(module, oldFile, target.file.path);
  return `${written.startsWith("./") ? "./" : ""}${newModule}#${newName}`;
}

/** A module path for `newFile` with as many segments as `module` had, and its extension style. */
function rewriteModule(module: string, oldFile: string, newFile: string): string {
  const withoutExt = (p: string): string => p.replace(/\.[^./]+$/, "");
  const hasExt = withoutExt(module) !== module && oldFile.endsWith(module);
  const target = hasExt ? newFile : withoutExt(newFile);
  const segments = module.split("/").length;
  const all = target.split("/");
  return segments >= all.length ? target : all.slice(-segments).join("/");
}

/**
 * Ops that make the binding's `file` hint match `newFile`: an entry that named the old file is
 * replaced; a glob that matched it is moved with the rename map's `paths` or with the old file's
 * folder; an entry about other files (another partial part) is left alone.
 */
function rewriteHints(
  spec: Spec,
  binding: Binding,
  oldFile: string | undefined,
  newFile: string,
  paths: Record<string, string> | undefined,
): PatchOp[] {
  if (!binding.file) return [];
  const raw = readYaml(spec.source.frontmatter.text, ["bindings", binding.index, "file"]);
  const hints = typeof raw === "string" ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const matches = (hint: string, file: string): boolean => hint === file || globMatcher(hint)(file);
  if (hints.some((h) => typeof h === "string" && matches(h, newFile))) return [];
  const out: PatchOp[] = [];
  hints.forEach((hint, i) => {
    if (typeof hint !== "string") return;
    const matchedOld = oldFile !== undefined ? matches(hint, oldFile) : !matches(hint, newFile);
    if (!matchedOld) return;
    const next = moveHint(hint, oldFile, newFile, paths);
    if (next === hint) return;
    out.push({
      op: "set",
      path:
        typeof raw === "string"
          ? ["bindings", binding.index, "file"]
          : ["bindings", binding.index, "file", i],
      value: next,
    });
  });
  return out;
}

function moveHint(
  hint: string,
  oldFile: string | undefined,
  newFile: string,
  paths: Record<string, string> | undefined,
): string {
  if (hint === oldFile || !/[*?[\]{}!]/.test(hint)) return newFile;
  const mapped = Object.entries(paths ?? {})
    .filter(([from]) => from !== "" && hint.startsWith(from))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (mapped) {
    const moved = mapped[1] + hint.slice(mapped[0].length);
    if (globMatcher(moved)(newFile)) return moved;
  }
  if (oldFile !== undefined) {
    const from = `${posix.dirname(oldFile)}/`;
    const to = `${posix.dirname(newFile)}/`;
    if (hint.startsWith(from)) {
      const moved = to + hint.slice(from.length);
      if (globMatcher(moved)(newFile)) return moved;
    }
  }
  return newFile;
}

/**
 * The lock entry of a moved binding: the new location, and the new shape when it differs from the
 * accepted (locked) shape only by the name. Drift that was never accepted stays drift.
 */
function moveLock(
  model: SpecModel,
  locks: Map<string, LockFile>,
  old: BaselineSymbol,
  target: SymbolEntry,
  files: string[] | undefined,
): void {
  const lock = locks.get(old.spec) ?? model.locks.get(old.spec);
  if (!lock) return;
  const shape = shapeOf(target.symbol);
  const previous = lock.symbols[old.binding];
  const accepted = previous ? nameFreeFingerprint(previous.shape) : old.nameFree;
  const nameOnly = nameFreeFingerprint(shape) === accepted;
  const entry: LockedSymbol = {
    resolved: `${target.file.path}#${target.symbol.qualifiedName}`,
    ...(files ? { files } : {}),
    fingerprint: nameOnly ? fingerprintOf(shape) : (previous?.fingerprint ?? old.fingerprint),
    shape: nameOnly ? shape : (previous?.shape ?? old.shape),
  };
  locks.set(old.spec, { ...lock, symbols: { ...lock.symbols, [old.binding]: entry } });
}

function ambiguous(model: SpecModel, ambiguity: Ambiguity): Diagnostic[] {
  const names = ambiguity.candidates.map(
    (c) =>
      `${c.entry.symbol.qualifiedName} (${formatLocation(c.entry.file.path, c.entry.symbol.nameRange)}${c.score < 1 ? `, score ${c.score.toFixed(2)}` : ""})`,
  );
  return ambiguity.bindings.flatMap((old) => {
    const spec = model.specs.get(old.spec);
    const binding = spec?.bindings.find((b) => b.id === old.binding);
    if (!spec || !binding) return [];
    const oldName = splitResolved(old.resolved).qualifiedName || old.shape.name;
    return [
      createDiagnostic("CS0216", {
        spec: spec.id,
        specLocation: specLocation(spec.source, ["bindings", binding.index, "symbol"]),
        bindingId: binding.id,
        item: `binding:${binding.id}`,
        message: `binding "${binding.id}": can't tell where ${oldName} went${ambiguity.detail ? ` (${ambiguity.detail})` : ""}; candidates: ${listOf(names)}; the spec is not changed`,
        expected: oldName,
        actual: ambiguity.candidates.map(
          (c) => `${c.entry.file.path}#${c.entry.symbol.qualifiedName}`,
        ),
        suggestions: [
          {
            message: `name the rename in a map: { "symbols": { "${oldName}": "<new name>" } } and run \`catspec sync --apply --map <file>\``,
          },
          { message: "or fix the binding's symbol by hand" },
        ],
      }),
    ];
  });
}

function lostDiagnostics(model: SpecModel, lost: Lost): Diagnostic[] {
  return lost.bindings.flatMap((old) => {
    const spec = model.specs.get(old.spec);
    const binding = spec?.bindings.find((b) => b.id === old.binding);
    if (!spec || !binding) return [];
    const oldName = splitResolved(old.resolved).qualifiedName || old.shape.name;
    const best = lost.best
      ? `; the closest candidate, ${lost.best.entry.symbol.qualifiedName} (${formatLocation(lost.best.entry.file.path, lost.best.entry.symbol.nameRange)}), scores ${lost.best.score.toFixed(2)}, below heal.threshold`
      : "";
    return [
      createDiagnostic("CS0217", {
        spec: spec.id,
        specLocation: specLocation(spec.source, ["bindings", binding.index, "symbol"]),
        bindingId: binding.id,
        item: `binding:${binding.id}`,
        message: `binding "${binding.id}": ${oldName} is gone and nothing replaces it${lost.detail ? ` (${lost.detail})` : ""}${best}`,
        expected: oldName,
        actual: "nothing",
        suggestions: [
          { message: "restore the code, add the rename to a map (--map), or change the spec" },
        ],
      }),
    ];
  });
}

interface Mention {
  line: number;
  column: number;
  /** Offset of the code span's content in the file. */
  offset: number;
  text: string;
  replacement: string;
}

/** Backticked mentions of renamed names in the spec body, outside fenced code blocks. */
function mentionsOf(spec: Spec, renames: { from: string[]; to: string }[]): Mention[] {
  if (renames.length === 0) return [];
  const { body } = spec.source;
  const mentions: Mention[] = [];
  let fenced = false;
  let offset = body.start;
  for (const [i, line] of body.text.split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const text = match[1]!;
        const replacement = replaceNames(text, renames);
        if (replacement === text) continue;
        mentions.push({
          line: body.line + i,
          column: match.index + 2,
          offset: offset + match.index + 1,
          text,
          replacement,
        });
      }
    }
    offset += line.length + 1;
  }
  return mentions;
}

/**
 * `text` with every old name replaced, whole words only, in one pass (a replacement is never
 * replaced again); at each place the longest (qualified) form wins.
 */
function replaceNames(text: string, renames: { from: string[]; to: string }[]): string {
  const replacements = new Map<string, string>();
  for (const r of renames) {
    for (const from of r.from) {
      const count = from.split(".").length;
      const to = r.to.split(".");
      const next = count >= to.length ? r.to : to.slice(-count).join(".");
      if (from !== next && !replacements.has(from)) replacements.set(from, next);
    }
  }
  if (replacements.size === 0) return text;
  const names = [...replacements.keys()].sort((a, b) => b.length - a.length);
  return text.replace(wordPattern(names, "."), (name) => replacements.get(name) ?? name);
}

/** Writes the mention replacements into the body of `text` (the edited file). */
function rewriteMentions(text: string, spec: Spec, mentions: Mention[]): string {
  const shift = text.length - spec.source.text.length;
  let body = text.slice(spec.source.body.start + shift);
  for (const m of [...mentions].reverse()) {
    const at = m.offset - spec.source.body.start;
    body = body.slice(0, at) + m.replacement + body.slice(at + m.text.length);
  }
  const frontmatter = text.slice(0, spec.source.body.start + shift);
  return frontmatter + body;
}

/** A `SpecPatch` for one edit, for diagnostics and the MCP layer. */
export const editPatch = (edit: SpecEdit): SpecPatch => ({ file: edit.spec.file, ops: edit.ops });
