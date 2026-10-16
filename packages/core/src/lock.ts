/**
 * Lock files (plan §D7, ADR-004), PBIs `lock-files`, `ratchet` and `drift-and-accept`: the
 * observed state of a spec, generated next to it as `<spec-id>.lock.json` and committed.
 *
 * - `items`: a hash of each contract item as the spec declares it, so a change to one item resets
 *   only that item (§D7.1).
 * - `satisfied`: items that passed once. A failure of one of them is a regression, CS0301, even
 *   while the spec is in progress (ADR-006).
 * - `symbols`: where each binding resolved, and the shape of the declaration (bodies excluded)
 *   with its fingerprint. A shape change of an implemented spec is drift, CS0300 (§D7.2), until
 *   `catspec accept` records it.
 *
 * The writer is deterministic: keys are sorted and lists ordered, so the same state gives the same
 * bytes on every platform.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { ItemResult } from "./check.js";
import { bindingItems } from "./contracts.js";
import { compareStrings, createDiagnostic, type Diagnostic } from "./diagnostics.js";
import type { ParamFact, SymbolFact } from "./facts.js";
import type { ResolvedBinding } from "./resolve.js";
import type { Binding } from "./spec-schema.js";
import { specLocation, type Spec } from "./spec.js";
import { listOf } from "./util.js";

/** The shape of a declaration: what a caller depends on, without bodies (§D7.2). */
export interface Shape {
  kind: string;
  name: string;
  bases: string[];
  attributes: string[];
  modifiers: string[];
  /** Parameters and return type of a function binding: `(string,number):boolean`. */
  signature?: string;
  /** Member signatures, sorted: `public method login(string):Promise<boolean>`. */
  members: string[];
}

export interface LockedSymbol {
  /** `path#QualifiedName` of the declaration (of its first part). */
  resolved: string;
  /** Every file of a C# partial type, when there is more than one. */
  files?: string[];
  fingerprint: string;
  shape: Shape;
}

export interface LockFile {
  spec: string;
  /** Hash of the spec's bindings and rules. */
  specHash: string;
  /** Hash of each contract item as declared, by item. */
  items: Record<string, string>;
  /** Items that passed at least once, sorted. */
  satisfied: string[];
  /** Observed declarations, by binding id. */
  symbols: Record<string, LockedSymbol>;
}

/** The lock file of a spec: `<spec-id>.lock.json` in the spec's folder. */
export const lockPathOf = (spec: { id: string; file: string }): string =>
  posix.join(posix.dirname(spec.file), `${spec.id}.lock.json`);

/** Specs that have lock files: every spec except the architecture spec. */
export const hasLockFile = (spec: Spec): boolean => spec.type !== "architecture";

const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

/** JSON with sorted object keys and no undefined values. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}

/** A frontmatter entry without its position in the list. */
function declared<T extends { index: number }>(entry: T): Omit<T, "index"> {
  const copy: Partial<T> = { ...entry };
  delete copy.index;
  return copy as Omit<T, "index">;
}

/**
 * The declared contract of a binding item. `symbol` and `file` are locations, not contract
 * (ADR-008): `catspec sync` rewrites them without resetting the ratchet.
 */
const bindingContract = (binding: Binding): unknown => ({
  kind: binding.kind,
  lang: binding.lang,
  implements: binding.implements,
  extends: binding.extends,
  attributes: binding.attributes,
  constructorRequires: binding.constructorRequires,
  exported: binding.exported,
});

/** The hash of every contract item of a spec, by item (§D7.1). */
export function itemHashes(spec: Spec): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const binding of spec.bindings) {
    hashes[`binding:${binding.id}`] = sha256(bindingContract(binding));
    for (const member of binding.members) {
      hashes[`binding:${binding.id}.${member.name}`] = sha256(member);
    }
  }
  for (const rule of spec.rules) hashes[`rule:${rule.id}`] = sha256(declared(rule));
  return hashes;
}

/** Hash of the whole contract of a spec. */
export const specHash = (spec: Spec): string =>
  sha256({
    bindings: spec.bindings.map(declared),
    rules: spec.rules.map(declared),
  });

const paramType = (p: ParamFact): string =>
  `${p.rest ? "..." : ""}${p.type?.text ?? "?"}${p.optional ? "?" : ""}`;

const callSignature = (s: SymbolFact): string =>
  `(${(s.params ?? []).map(paramType).join(",")})${s.returns ? `:${s.returns.text}` : ""}`;

const sortedModifiers = (s: SymbolFact): string[] => [...s.modifiers].sort(compareStrings);

const attributeText = (a: { name: string; args: string[] }): string =>
  a.args.length > 0 ? `${a.name}(${a.args.join(",")})` : a.name;

/** The shape of a declaration: kind, name, bases, attributes, modifiers and member signatures. */
export function shapeOf(symbol: SymbolFact): Shape {
  const member = (m: SymbolFact): string => {
    const modifiers = sortedModifiers(m);
    const head = [...modifiers, m.kind, m.name].join(" ");
    return m.params !== undefined
      ? `${head}${callSignature(m)}`
      : `${head}${m.returns ? `:${m.returns.text}` : ""}`;
  };
  const shape: Shape = {
    kind: symbol.kind,
    name: symbol.qualifiedName,
    bases: symbol.bases.map((b) => b.text),
    attributes: symbol.attributes.map(attributeText).sort(compareStrings),
    modifiers: sortedModifiers(symbol),
    members: symbol.members.map(member).sort(compareStrings),
  };
  if (symbol.params !== undefined) shape.signature = callSignature(symbol);
  return shape;
}

export const fingerprintOf = (shape: Shape): string => sha256(shape);

/** The files a locked binding resolved to, for binding resolution (§D11.5 step 2). */
export function lockedFiles(lock: LockFile | undefined, bindingId: string): string[] {
  const entry = lock?.symbols[bindingId];
  if (!entry) return [];
  if (entry.files && entry.files.length > 0) return entry.files;
  const hash = entry.resolved.lastIndexOf("#");
  return [hash === -1 ? entry.resolved : entry.resolved.slice(0, hash)];
}

/** Parses a lock file; undefined when it isn't a valid lock file (it is then rebuilt). */
export function parseLock(text: string): LockFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const lock = value as Partial<LockFile>;
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (
    typeof lock.spec !== "string" ||
    !Array.isArray(lock.satisfied) ||
    !lock.satisfied.every((s) => typeof s === "string") ||
    !isRecord(lock.items) ||
    !isRecord(lock.symbols) ||
    !Object.values(lock.symbols).every(
      (s) =>
        isRecord(s) &&
        typeof s.resolved === "string" &&
        typeof s.fingerprint === "string" &&
        isRecord(s.shape),
    )
  ) {
    return undefined;
  }
  return {
    spec: lock.spec,
    specHash: typeof lock.specHash === "string" ? lock.specHash : "",
    items: lock.items,
    satisfied: lock.satisfied,
    symbols: lock.symbols,
  };
}

/**
 * The lock file's text: the fields in the order of plan §D7, every map sorted by key, two-space
 * indent, `\n` line endings and a final newline.
 */
export function serializeLock(lock: LockFile): string {
  const symbols = Object.fromEntries(
    Object.keys(lock.symbols)
      .sort(compareStrings)
      .map((id) => {
        const { resolved, files, fingerprint, shape } = lock.symbols[id]!;
        return [id, { resolved, files, fingerprint, shape: sortKeys(shape) }];
      }),
  );
  const ordered = {
    spec: lock.spec,
    specHash: lock.specHash,
    items: sortKeys(lock.items),
    satisfied: lock.satisfied,
    symbols,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Items of the lock that still mean what the spec declares: same hash as when they passed. */
function stillSatisfied(lock: LockFile | undefined, hashes: Record<string, string>): Set<string> {
  if (!lock) return new Set();
  return new Set(
    lock.satisfied.filter(
      (item) => hashes[item] !== undefined && lock.items[item] === hashes[item],
    ),
  );
}

/** True when a binding's declared contract (its item and every member item) is unchanged. */
function bindingUnchanged(
  binding: Binding,
  lock: LockFile,
  hashes: Record<string, string>,
): boolean {
  const items = bindingItems(binding);
  const locked = Object.keys(lock.items).filter(
    (item) => item === `binding:${binding.id}` || item.startsWith(`binding:${binding.id}.`),
  );
  return locked.length === items.length && items.every((item) => lock.items[item] === hashes[item]);
}

export interface LockCheckOptions {
  /** Severity of drift for implemented specs (`enforcement.drift`). */
  drift: "off" | "warn" | "strict";
  /** `full`: the spec is checked as if implemented (`check --spec`). */
  asImplemented?: boolean;
}

/**
 * The ratchet and drift for one spec (§D7.1, §D7.2, §D8): a failure of an item that passed
 * before becomes CS0301 (an error, also in progress), and a shape change of a binding whose
 * contract didn't change is CS0300 (info in progress, `enforcement.drift` when implemented).
 */
export function applyLock(
  spec: Spec,
  diagnostics: Diagnostic[],
  resolved: ReadonlyMap<string, ResolvedBinding>,
  lock: LockFile | undefined,
  options: LockCheckOptions,
): Diagnostic[] {
  if (!lock || spec.type === "architecture") return diagnostics;
  const hashes = itemHashes(spec);
  const satisfied = stillSatisfied(lock, hashes);
  const out = diagnostics.map((d) =>
    d.item !== undefined &&
    satisfied.has(d.item) &&
    d.severity !== "info" &&
    d.code !== "CS0220" &&
    d.code !== "CS0401"
      ? {
          ...d,
          code: "CS0301" as const,
          severity: "error" as const,
          message: `regression: ${d.item} passed before and now fails: ${d.code} ${d.message}`,
        }
      : d,
  );

  const implemented = options.asImplemented === true || spec.status === "implemented";
  const severity = implemented
    ? options.drift === "off"
      ? undefined
      : options.drift === "strict"
        ? ("error" as const)
        : ("warning" as const)
    : ("info" as const);
  if (severity === undefined) return out;
  for (const binding of spec.bindings) {
    const entry = lock.symbols[binding.id];
    const current = resolved.get(binding.id);
    if (!entry || !current || !bindingUnchanged(binding, lock, hashes)) continue;
    const shape = shapeOf(current.symbol);
    if (fingerprintOf(shape) === entry.fingerprint) continue;
    const changes = shapeChanges(entry.shape, shape);
    out.push(
      createDiagnostic("CS0300", {
        spec: spec.id,
        specLocation: specLocation(spec.source, ["bindings", binding.index, "symbol"]),
        codeLocation: {
          file: current.file.path,
          line: current.symbol.nameRange.start.line,
          column: current.symbol.nameRange.start.column,
        },
        bindingId: binding.id,
        severity,
        message: `binding "${binding.id}": the shape of ${current.symbol.qualifiedName} changed and the spec doesn't mention it: ${listOf(changes)}`,
        expected: entry.shape,
        actual: shape,
        suggestions: [
          { message: `run \`catspec accept ${spec.id}\` if the change is intended` },
          { message: "or update the spec, or change the code back" },
        ],
      }),
    );
  }
  return out;
}

/** Human-readable differences between two shapes. */
function shapeChanges(before: Shape, after: Shape): string[] {
  const changes: string[] = [];
  if (before.kind !== after.kind) changes.push(`kind ${before.kind} → ${after.kind}`);
  if (before.name !== after.name) changes.push(`name ${before.name} → ${after.name}`);
  if ((before.signature ?? "") !== (after.signature ?? "")) {
    changes.push(`signature ${before.signature ?? "none"} → ${after.signature ?? "none"}`);
  }
  const lists: [string, keyof Shape][] = [
    ["base", "bases"],
    ["attribute", "attributes"],
    ["modifier", "modifiers"],
    ["member", "members"],
  ];
  for (const [label, key] of lists) {
    const a = (before[key] as string[] | undefined) ?? [];
    const b = (after[key] as string[] | undefined) ?? [];
    for (const removed of a.filter((x) => !b.includes(x))) changes.push(`- ${label} ${removed}`);
    for (const added of b.filter((x) => !a.includes(x))) changes.push(`+ ${label} ${added}`);
  }
  return changes.length > 0 ? changes : ["the shape changed"];
}

export interface NextLockOptions {
  /**
   * `update` (the hook): keeps the ratchet history, and the accepted shapes of an implemented
   * spec until they are accepted. `accept`: records the current shapes. `rebuild`: from the
   * current code only, without history.
   */
  mode: "update" | "accept" | "rebuild";
}

/** The lock file after a check of `spec`. */
export function nextLock(
  spec: Spec,
  items: readonly ItemResult[],
  resolved: ReadonlyMap<string, ResolvedBinding>,
  previous: LockFile | undefined,
  options: NextLockOptions,
): LockFile {
  const hashes = itemHashes(spec);
  const prev = options.mode === "rebuild" ? undefined : previous;
  const satisfied = stillSatisfied(prev, hashes);
  for (const item of items) {
    if (item.spec === spec.id && item.passed && hashes[item.item] !== undefined) {
      satisfied.add(item.item);
    }
  }
  const symbols: Record<string, LockedSymbol> = {};
  for (const binding of spec.bindings) {
    const current = resolved.get(binding.id);
    const old = prev?.symbols[binding.id];
    if (!current) {
      if (old) symbols[binding.id] = old;
      continue;
    }
    const shape = shapeOf(current.symbol);
    const location: Pick<LockedSymbol, "resolved" | "files"> = {
      resolved: `${current.file.path}#${current.symbol.qualifiedName}`,
      ...(current.files.length > 1 ? { files: [...current.files].sort(compareStrings) } : {}),
    };
    const keepAccepted =
      options.mode === "update" &&
      old !== undefined &&
      prev !== undefined &&
      spec.status === "implemented" &&
      bindingUnchanged(binding, prev, hashes);
    symbols[binding.id] = keepAccepted
      ? { ...location, fingerprint: old.fingerprint, shape: old.shape }
      : { ...location, fingerprint: fingerprintOf(shape), shape };
  }
  return {
    spec: spec.id,
    specHash: specHash(spec),
    items: hashes,
    satisfied: [...satisfied].sort(compareStrings),
    symbols,
  };
}
