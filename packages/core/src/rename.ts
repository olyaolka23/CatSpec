/**
 * Rename and move detection (plan §D11.4, §D11.8, analysis F-7, ADR-013), PBIs `rename-detection`
 * and `batch-rename-mapping`: works out where the declarations that bindings pointed to went.
 *
 * The input is a baseline: what each binding resolved to before the change (from the refactor
 * baseline, or from the lock file and `HEAD`). Every baseline declaration that no longer resolves
 * is matched to a declaration of the current code, using the strongest evidence first:
 *
 * 1. the rename map (`--map`): symbols, namespaces, paths;
 * 2. the same qualified name in another file (moved);
 * 3. a namespace or module prefix change shared by several declarations (`Identity.*` →
 *    `Accounts.*`);
 * 4. a file rename from `git diff -M`, same name in the new file;
 * 5. an identical name-free fingerprint, unique on both sides;
 * 6. the similarity score `0.5·jaccard(member names) + 0.4·jaccard(body token 3-grams) +
 *    0.1·same file`.
 *
 * Rows 5 and 6 are a global one-to-one assignment: a new declaration is used at most once, and a
 * pair is taken only when both are each other's unique best match at or above `heal.threshold`.
 * Every declaration ends up mapped, ambiguous (CS0216) or lost (CS0217); nothing is guessed.
 */
import { createHash } from "node:crypto";

import type { SymbolEntry, SymbolTable } from "./codebase.js";
import { compareStrings } from "./diagnostics.js";
import type { FileFacts, Range, SourceFile, SymbolFact } from "./facts.js";
import { fingerprintOf, shapeOf, type LockedSymbol, type Shape } from "./lock.js";
import { nameMatches } from "./match.js";
import { inModule, splitSymbol } from "./resolve.js";
import { LineIndex } from "./util.js";

/** A declaration a binding resolved to before the change. */
export interface BaselineSymbol {
  /** Spec id. */
  spec: string;
  /** Binding id. */
  binding: string;
  /** `path#QualifiedName` of the declaration. */
  resolved: string;
  /** Every file of a C# partial type, when there is more than one. */
  files?: string[];
  fingerprint: string;
  /** Fingerprint of the shape without the declaration's own name and namespace. */
  nameFree: string;
  shape: Shape;
  /** Body tokens without the declaration's own name; empty when its source wasn't available. */
  tokens: string[];
}

/** The rename map of `catspec sync --map` (plan §D11.8). */
export interface RenameMap {
  /** Old qualified name (or `path#Name`) → new qualified name. */
  symbols?: Record<string, string>;
  /** Old namespace or name prefix → new one, segment-wise: `Identity` → `Accounts`. */
  namespaces?: Record<string, string>;
  /** Old path prefix → new one: `src/Identity/` → `src/Accounts/`. */
  paths?: Record<string, string>;
}

/** How a mapping was found, strongest first (the rows of plan §D11.8). */
export type Evidence = "map" | "moved" | "prefix" | "file-rename" | "fingerprint" | "similarity";

/** A candidate with its similarity score. */
export interface ScoredCandidate {
  entry: SymbolEntry;
  score: number;
}

/** A baseline declaration mapped to a declaration of the current code. */
export interface Mapping {
  /** The bindings that pointed to the old declaration (one declaration can be bound twice). */
  bindings: BaselineSymbol[];
  target: SymbolEntry;
  evidence: Evidence;
  /** The similarity score, when computed. */
  score?: number;
  /** What the evidence was, e.g. `namespace Identity → Accounts`. */
  detail?: string;
}

export interface Ambiguity {
  bindings: BaselineSymbol[];
  /** Best first. */
  candidates: ScoredCandidate[];
  detail?: string;
}

export interface Lost {
  bindings: BaselineSymbol[];
  /** The closest candidate, below the threshold. */
  best?: ScoredCandidate;
  detail?: string;
}

export interface RenameReport {
  mapped: Mapping[];
  ambiguous: Ambiguity[];
  lost: Lost[];
}

export interface RenameInput {
  /** The bindings that no longer resolve, with what they resolved to before. */
  broken: readonly BaselineSymbol[];
  /** Every declaration of the current code. */
  table: SymbolTable;
  /** Current files that the baseline revision doesn't have, or has with other content. */
  changed: ReadonlySet<string>;
  /** Facts of the baseline versions of the files that changed or were deleted. */
  before: readonly FileFacts[];
  /** File renames from `git diff -M`: old path → new path. */
  renames?: ReadonlyMap<string, string>;
  map?: RenameMap;
  /** `heal.threshold`. */
  threshold: number;
  /** Body tokens of a current declaration (`bodyTokens`), computed only for scored candidates. */
  tokens: (entry: SymbolEntry) => Promise<string[]>;
  /** Ids (`path#id`) of current declarations that other bindings resolve to; never candidates. */
  taken?: ReadonlySet<string>;
}

const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** The last segment of a qualified name. */
const simpleName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);

/** `path#QualifiedName` → path and qualified name. */
export function splitResolved(resolved: string): { file: string; qualifiedName: string } {
  const hash = resolved.lastIndexOf("#");
  return hash === -1
    ? { file: resolved, qualifiedName: "" }
    : { file: resolved.slice(0, hash), qualifiedName: resolved.slice(hash + 1) };
}

const wordPattern = (word: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_$])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_$])`,
    "gu",
  );

/**
 * A shape without the declaration's own name: the qualified name is dropped and the simple name
 * is blanked where members repeat it (C# constructors), so a rename alone keeps the fingerprint.
 */
export function nameFreeFingerprint(shape: Shape): string {
  const name = simpleName(shape.name);
  const pattern = name ? wordPattern(name) : undefined;
  const blank = (text: string): string => (pattern ? text.replace(pattern, "∅") : text);
  return sha256([
    shape.kind,
    [...shape.bases].sort(compareStrings),
    [...shape.attributes].sort(compareStrings),
    [...shape.modifiers].sort(compareStrings),
    shape.signature === undefined ? null : blank(shape.signature),
    shape.members.map(blank).sort(compareStrings),
  ]);
}

/** The member names of a shape (`public method login(string):boolean` → `login`). */
export function memberNames(shape: Shape): string[] {
  return shape.members.map((member) => {
    const head = member.split(/[(:]/)[0]!.trim();
    return head.slice(head.lastIndexOf(" ") + 1);
  });
}

const TOKEN =
  /[\p{L}_$][\p{L}\p{N}_$]*|\d[\p{L}\p{N}_.]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\S/gu;

/**
 * The tokens of a declaration's source, without its own name: identifiers, numbers, strings and
 * punctuation. Language-independent, for the similarity score only (never written anywhere).
 */
export function bodyTokens(source: SourceFile, symbol: SymbolFact): string[] {
  const text = sliceRange(source.text, symbol.range);
  const tokens = text.match(TOKEN) ?? [];
  return tokens.filter((t) => t !== symbol.name);
}

function sliceRange(text: string, range: Range): string {
  const lines = new LineIndex(text);
  const offset = (p: Range["start"]): number => lines.lineStart(p.line) + p.column - 1;
  return text.slice(offset(range.start), offset(range.end));
}

/** Jaccard index of two sets; two empty sets are equal. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

/** Token 3-grams (or the tokens themselves when there are fewer than three). */
const trigrams = (tokens: readonly string[]): Set<string> => {
  if (tokens.length < 3) return new Set(tokens);
  const grams = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    grams.add(`${tokens[i]}\u0000${tokens[i + 1]}\u0000${tokens[i + 2]}`);
  }
  return grams;
};

/** Similarity of two bodies: Jaccard over token 3-grams; 0 when either body is unknown. */
export function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  return jaccard(trigrams(a), trigrams(b));
}

/**
 * The rename score of plan §D11.4: `0.5·jaccard(member names) + 0.4·tokenSimilarity(body) +
 * 0.1·sameFile`. Declarations without members (functions) compare their signatures instead.
 */
export function renameScore(
  before: { shape: Shape; tokens: readonly string[] },
  after: { shape: Shape; tokens: readonly string[] },
  sameFile: boolean,
): number {
  const a = new Set(memberNames(before.shape));
  const b = new Set(memberNames(after.shape));
  const members =
    a.size === 0 && b.size === 0
      ? (before.shape.signature ?? "") === (after.shape.signature ?? "")
        ? 1
        : 0
      : jaccard(a, b);
  const score = 0.5 * members + 0.4 * tokenSimilarity(before.tokens, after.tokens);
  return Math.round((score + (sameFile ? 0.1 : 0)) * 1e6) / 1e6;
}

/** A baseline entry from a lock file's `symbols` entry and, when available, the old source. */
export function baselineFromLock(
  spec: string,
  binding: string,
  locked: LockedSymbol,
  tokens: string[] = [],
): BaselineSymbol {
  return {
    spec,
    binding,
    resolved: locked.resolved,
    ...(locked.files ? { files: locked.files } : {}),
    fingerprint: locked.fingerprint,
    nameFree: nameFreeFingerprint(locked.shape),
    shape: locked.shape,
    tokens,
  };
}

/** A baseline entry from a declaration resolved in the baseline revision. */
export function baselineFromSymbol(
  spec: string,
  binding: string,
  resolved: { symbol: SymbolFact; file: { path: string }; files: string[] },
  source?: SourceFile,
): BaselineSymbol {
  const shape = shapeOf(resolved.symbol);
  return {
    spec,
    binding,
    resolved: `${resolved.file.path}#${resolved.symbol.qualifiedName}`,
    ...(resolved.files.length > 1 ? { files: [...resolved.files].sort(compareStrings) } : {}),
    fingerprint: fingerprintOf(shape),
    nameFree: nameFreeFingerprint(shape),
    shape,
    tokens: source ? bodyTokens(source, resolved.symbol) : [],
  };
}

/** An old declaration and every binding that pointed to it. */
interface Group {
  key: string;
  file: string;
  qualifiedName: string;
  kind: string;
  bindings: BaselineSymbol[];
  /** The first binding's baseline entry (shape and tokens are the same for all). */
  first: BaselineSymbol;
}

const entryKey = (e: SymbolEntry): string => `${e.file.path}#${e.symbol.id}`;

/** True when a path segment prefix applies: `Identity` is a prefix of `Identity.Users.X`. */
const segmentPrefix = (prefix: string, name: string, sep: string): boolean =>
  prefix === "" || name === prefix || name.startsWith(prefix + sep);

/** Replaces the longest matching prefix of `name` from `prefixes`; undefined when none applies. */
function replacePrefix(
  name: string,
  prefixes: Record<string, string> | undefined,
  sep: string,
): string | undefined {
  if (!prefixes) return undefined;
  const keys = Object.keys(prefixes)
    .filter((k) => k !== "" && (sep === "/" ? name.startsWith(k) : segmentPrefix(k, name, sep)))
    .sort((a, b) => b.length - a.length);
  const key = keys[0];
  return key === undefined ? undefined : prefixes[key]! + name.slice(key.length);
}

/** Maps every broken binding of `input` to its new declaration, or reports why it can't. */
export async function detectRenames(input: RenameInput): Promise<RenameReport> {
  const groups = groupBroken(input.broken);
  const report: RenameReport = { mapped: [], ambiguous: [], lost: [] };
  if (groups.length === 0) return report;

  const taken = input.taken ?? new Set<string>();
  const changedEntries = input.table.entries.filter(
    (e) => input.changed.has(e.file.path) && !taken.has(entryKey(e)),
  );
  // Declarations of the changed files that the baseline didn't have: rename candidates.
  const before = new Set<string>();
  const addBefore = (s: SymbolFact): void => {
    before.add(`${s.kind}\u0000${s.qualifiedName}`);
    s.members.forEach(addBefore);
  };
  for (const file of input.before) file.symbols.forEach(addBefore);
  const fresh = changedEntries.filter(
    (e) => !before.has(`${e.symbol.kind}\u0000${e.symbol.qualifiedName}`),
  );

  /** A mapping by exact evidence, before the conflict check; or an outcome that ends the search. */
  type Exact =
    | { kind: "mapped"; target: SymbolEntry; evidence: Evidence; detail?: string }
    | { kind: "ambiguous"; candidates: SymbolEntry[]; detail: string }
    | { kind: "lost"; detail: string };
  const exact = new Map<Group, Exact>();
  const ofKind = (entries: readonly SymbolEntry[], g: Group): SymbolEntry[] =>
    entries.filter((e) => e.symbol.kind === g.kind && !taken.has(entryKey(e)));
  const decide = (
    g: Group,
    found: SymbolEntry[],
    evidence: Evidence,
    detail: string,
  ): Exact | undefined => {
    const unique = dedupe(found);
    if (unique.length === 1) return { kind: "mapped", target: unique[0]!, evidence, detail };
    if (unique.length > 1) return { kind: "ambiguous", candidates: unique, detail };
    return undefined;
  };

  // Rows 1 and 2: the rename map, then the same qualified name elsewhere.
  for (const g of groups) {
    const result = fromMap(g) ?? moved(g);
    if (result) exact.set(g, result);
  }

  function fromMap(g: Group): Exact | undefined {
    const map = input.map;
    if (!map) return undefined;
    for (const [from, to] of Object.entries(map.symbols ?? {})) {
      const { module, name } = splitSymbol(from);
      if (module !== undefined && !inModule(g.file, module)) continue;
      if (!nameMatches(name, g.qualifiedName)) continue;
      const target = splitSymbol(to);
      const found = ofKind(input.table.find(target.name), g).filter(
        (e) => target.module === undefined || inModule(e.file.path, target.module),
      );
      return (
        decide(g, found, "map", `rename map: ${from} → ${to}`) ?? {
          kind: "lost",
          detail: `the rename map names ${to}, which isn't in the code`,
        }
      );
    }
    const name = replacePrefix(g.qualifiedName, map.namespaces, ".");
    const file = replacePrefix(g.file, map.paths, "/");
    if (name === undefined && file === undefined) return undefined;
    const qualifiedName = name ?? g.qualifiedName;
    const inFile = file ?? g.file;
    const exactly = ofKind(input.table.find(qualifiedName), g).filter(
      (e) => e.symbol.qualifiedName === qualifiedName,
    );
    const detail = [
      name !== undefined ? `namespace ${g.qualifiedName} → ${qualifiedName}` : undefined,
      file !== undefined ? `path ${g.file} → ${inFile}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const there = exactly.filter((e) => e.file.path === inFile);
    return (
      decide(g, there.length > 0 ? there : exactly, "map", `rename map: ${detail}`) ??
      (file !== undefined && name === undefined
        ? decide(
            g,
            ofKind(input.table.entries, g).filter(
              (e) => e.file.path === inFile && e.symbol.name === simpleName(g.qualifiedName),
            ),
            "map",
            `rename map: ${detail}`,
          )
        : undefined)
    );
  }

  function moved(g: Group): Exact | undefined {
    const found = ofKind(input.table.find(g.qualifiedName), g).filter(
      (e) => e.symbol.qualifiedName === g.qualifiedName && e.file.path !== g.file,
    );
    return decide(g, found, "moved", `moved from ${g.file}`);
  }

  // Row 3: a prefix change shared by several declarations (`Identity.*` → `Accounts.*`).
  const remaining = (): Group[] => groups.filter((g) => !exact.has(g));
  const prefixVotes = new Map<string, Set<Group>>();
  for (const g of remaining()) {
    const oldSegments = g.qualifiedName.split(".");
    for (const e of ofKind(fresh, g)) {
      if (e.symbol.name !== simpleName(g.qualifiedName)) continue;
      const newSegments = e.symbol.qualifiedName.split(".");
      let common = 0;
      while (
        common < oldSegments.length &&
        common < newSegments.length &&
        oldSegments[oldSegments.length - 1 - common] ===
          newSegments[newSegments.length - 1 - common]
      ) {
        common++;
      }
      const from = oldSegments.slice(0, oldSegments.length - common).join(".");
      const to = newSegments.slice(0, newSegments.length - common).join(".");
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      prefixVotes.set(key, (prefixVotes.get(key) ?? new Set()).add(g));
    }
  }
  const prefixes = [...prefixVotes.entries()]
    .filter(([, voters]) => voters.size >= 2)
    .map(([key]) => key.split("\u0000") as [string, string])
    .sort((a, b) => b[0].length - a[0].length);
  for (const g of remaining()) {
    const rule = prefixes.find(
      ([from]) => from !== "" && segmentPrefix(from, g.qualifiedName, "."),
    );
    if (!rule) continue;
    const [from, to] = rule;
    const qualifiedName = to + g.qualifiedName.slice(from.length);
    const found = ofKind(fresh, g).filter((e) => e.symbol.qualifiedName === qualifiedName);
    const result = decide(g, found, "prefix", `namespace ${from} → ${to}`);
    if (result) exact.set(g, result);
  }

  // Row 4: the file was renamed; the same name in the new file.
  for (const g of remaining()) {
    const renamed = input.renames?.get(g.file);
    if (renamed === undefined) continue;
    const found = ofKind(changedEntries, g).filter(
      (e) => e.file.path === renamed && e.symbol.name === simpleName(g.qualifiedName),
    );
    const result = decide(g, found, "file-rename", `file renamed: ${g.file} → ${renamed}`);
    if (result) exact.set(g, result);
  }

  // Exact evidence must not use one declaration twice either.
  const claims = new Map<string, Group[]>();
  for (const [g, result] of exact) {
    if (result.kind !== "mapped") continue;
    const key = entryKey(result.target);
    claims.set(key, [...(claims.get(key) ?? []), g]);
  }
  const used = new Set<string>();
  for (const [g, result] of exact) {
    if (result.kind === "lost") {
      report.lost.push({ bindings: g.bindings, detail: result.detail });
    } else if (result.kind === "ambiguous") {
      report.ambiguous.push({
        bindings: g.bindings,
        candidates: result.candidates.map((entry) => ({ entry, score: 1 })),
        detail: result.detail,
      });
    } else if (claims.get(entryKey(result.target))!.length > 1) {
      report.ambiguous.push({
        bindings: g.bindings,
        candidates: [{ entry: result.target, score: 1 }],
        detail: `${result.target.symbol.qualifiedName} is also the target of ${listOfNames(
          claims.get(entryKey(result.target))!.filter((other) => other !== g),
        )}`,
      });
      used.add(entryKey(result.target));
    } else {
      report.mapped.push({
        bindings: g.bindings,
        target: result.target,
        evidence: result.evidence,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      });
      used.add(entryKey(result.target));
    }
  }

  // Rows 5 and 6: global one-to-one assignment over the remaining declarations.
  const open = remaining();
  const pool = fresh.filter((e) => !used.has(entryKey(e)));
  const shapes = new Map<SymbolEntry, Shape>();
  const shapeFor = (e: SymbolEntry): Shape => {
    let shape = shapes.get(e);
    if (!shape) shapes.set(e, (shape = shapeOf(e.symbol)));
    return shape;
  };
  const nameFree = new Map<SymbolEntry, string>();
  const nameFreeFor = (e: SymbolEntry): string => {
    let fp = nameFree.get(e);
    if (fp === undefined) nameFree.set(e, (fp = nameFreeFingerprint(shapeFor(e))));
    return fp;
  };

  // Row 5: the name-free fingerprint is identical, and unique on both sides.
  const assigned = new Map<Group, Mapping>();
  const byPrint = new Map<string, { groups: Group[]; entries: SymbolEntry[] }>();
  for (const g of open) {
    const slot = byPrint.get(`${g.kind}\u0000${g.first.nameFree}`) ?? { groups: [], entries: [] };
    slot.groups.push(g);
    byPrint.set(`${g.kind}\u0000${g.first.nameFree}`, slot);
  }
  for (const e of pool) {
    const slot = byPrint.get(`${e.symbol.kind}\u0000${nameFreeFor(e)}`);
    if (slot) slot.entries.push(e);
  }
  for (const { groups: gs, entries } of byPrint.values()) {
    if (gs.length !== 1 || entries.length !== 1) continue;
    const g = gs[0]!;
    const target = entries[0]!;
    const score = renameScore(
      g.first,
      { shape: shapeFor(target), tokens: await input.tokens(target) },
      sameFile(g, target),
    );
    assigned.set(g, {
      bindings: g.bindings,
      target,
      evidence: "fingerprint",
      score,
      detail: "only the name changed",
    });
  }

  // Row 6: similarity, mutual unique best matches at or above the threshold.
  const unassigned = open.filter((g) => !assigned.has(g));
  const targets = new Set(pool.filter((e) => ![...assigned.values()].some((m) => m.target === e)));
  const scores = new Map<Group, ScoredCandidate[]>();
  for (const g of unassigned) {
    const scored: ScoredCandidate[] = [];
    for (const e of targets) {
      if (e.symbol.kind !== g.kind) continue;
      const score = renameScore(
        g.first,
        { shape: shapeFor(e), tokens: await input.tokens(e) },
        sameFile(g, e),
      );
      scored.push({ entry: e, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || compareStrings(entryKey(a.entry), entryKey(b.entry)),
    );
    scores.set(g, scored);
  }
  const EPSILON = 1e-9;
  for (;;) {
    const free = unassigned.filter((g) => !assigned.has(g));
    const best = (g: Group): ScoredCandidate[] => {
      const live = scores.get(g)!.filter((c) => targets.has(c.entry) && c.score >= input.threshold);
      return live.filter((c) => c.score >= live[0]!.score - EPSILON);
    };
    const bestOld = new Map<SymbolEntry, { score: number; groups: Group[] }>();
    for (const g of free) {
      for (const c of scores.get(g)!) {
        if (!targets.has(c.entry) || c.score < input.threshold) continue;
        const slot = bestOld.get(c.entry);
        if (!slot || c.score > slot.score + EPSILON)
          bestOld.set(c.entry, { score: c.score, groups: [g] });
        else if (Math.abs(c.score - slot.score) <= EPSILON) slot.groups.push(g);
      }
    }
    let progress = false;
    for (const g of free) {
      const top = scores.get(g)!.length > 0 ? best(g) : [];
      if (top.length !== 1) continue;
      const candidate = top[0]!;
      const mutual = bestOld.get(candidate.entry);
      if (!mutual || mutual.groups.length !== 1 || mutual.groups[0] !== g) continue;
      assigned.set(g, {
        bindings: g.bindings,
        target: candidate.entry,
        evidence: "similarity",
        score: candidate.score,
      });
      targets.delete(candidate.entry);
      progress = true;
    }
    if (!progress) break;
  }

  for (const g of open) {
    const mapping = assigned.get(g);
    if (mapping) {
      report.mapped.push(mapping);
      continue;
    }
    // Candidates a closer match took are no longer candidates.
    const scored = (scores.get(g) ?? []).filter((c) => targets.has(c.entry));
    const above = scored.filter((c) => c.score >= input.threshold);
    if (above.length > 0) {
      report.ambiguous.push({
        bindings: g.bindings,
        candidates: above.slice(0, 5),
        detail: "several candidates are equally close",
      });
    } else {
      report.lost.push({
        bindings: g.bindings,
        ...(scored[0] && scored[0].score > 0 ? { best: scored[0] } : {}),
      });
    }
  }
  const order = (bindings: BaselineSymbol[]): string =>
    `${bindings[0]!.spec}\u0000${bindings[0]!.binding}`;
  report.mapped.sort((a, b) => compareStrings(order(a.bindings), order(b.bindings)));
  report.ambiguous.sort((a, b) => compareStrings(order(a.bindings), order(b.bindings)));
  report.lost.sort((a, b) => compareStrings(order(a.bindings), order(b.bindings)));
  return report;

  function sameFile(g: Group, e: SymbolEntry): boolean {
    return e.file.path === g.file || input.renames?.get(g.file) === e.file.path;
  }
}

function groupBroken(broken: readonly BaselineSymbol[]): Group[] {
  const groups = new Map<string, Group>();
  for (const b of broken) {
    const group = groups.get(b.resolved);
    if (group) {
      group.bindings.push(b);
      continue;
    }
    const { file, qualifiedName } = splitResolved(b.resolved);
    groups.set(b.resolved, {
      key: b.resolved,
      file,
      qualifiedName: qualifiedName || b.shape.name,
      kind: b.shape.kind,
      bindings: [b],
      first: b,
    });
  }
  return [...groups.values()].sort((a, b) => compareStrings(a.key, b.key));
}

function dedupe(entries: SymbolEntry[]): SymbolEntry[] {
  const seen = new Map<string, SymbolEntry>();
  for (const e of entries) {
    // Overload signatures and their implementation are one declaration.
    const key = `${e.file.path}\u0000${e.symbol.qualifiedName}\u0000${e.symbol.kind}`;
    if (!seen.has(key) || e.symbol.id === `${e.file.path}#${e.symbol.qualifiedName}`)
      seen.set(key, e);
  }
  return [...seen.values()];
}

const listOfNames = (groups: Group[]): string => groups.map((g) => g.qualifiedName).join(", ");
