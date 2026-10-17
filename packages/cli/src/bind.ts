/**
 * `catspec bind <symbol> --spec <id> [--file f]` (plan §D10, §D11.6), PBI `bind-command`: writes
 * a binding for a declaration that already exists, with its current shape copied as the contract,
 * so a spec for existing code passes as soon as it is written.
 */
import {
  applyPatch,
  createDiagnostic,
  globMatcher,
  MEMBER_KINDS,
  readYaml,
  resolveBinding,
  SymbolTable,
  type Binding,
  type Codebase,
  type Diagnostic,
  type ParamFact,
  type Spec,
  type SymbolFact,
} from "@catspec/core";

export interface BindResult {
  /** The spec file's new text, when a binding was found. */
  text?: string;
  /** The binding written, as YAML data. */
  binding?: Record<string, unknown>;
  /** The declaration bound: `path#QualifiedName`. */
  resolved?: string;
  /** Why nothing was written: CS0201 not found, CS0202 ambiguous. */
  diagnostics: Diagnostic[];
}

const MEMBERS = new Set<string>(MEMBER_KINDS);
const HIDDEN = new Set(["private", "protected"]);
const CONSTRUCTOR: string = "constructor";

/** The binding for `symbol` in `spec`, scaffolded from the declaration's current shape. */
export function bindSymbol(
  spec: Spec,
  codebase: Codebase,
  symbol: string,
  file?: string,
): BindResult {
  const table = new SymbolTable(codebase.files);
  const used = new Set(spec.bindings.map((b) => b.id));
  const probe: Binding = {
    id: uniqueId(symbol, used),
    symbol,
    members: [],
    index: spec.bindings.length,
    ...(file !== undefined ? { file: [file] } : {}),
  };
  const resolution = resolveBinding(spec, probe, table);
  // The probe isn't in the spec yet: its diagnostics have no place in the file.
  const withoutSpecLocation = (d: Diagnostic): Diagnostic => {
    const copy = { ...d };
    delete copy.specLocation;
    return copy;
  };
  const resolved = resolution.resolved;
  if (!resolved) return { diagnostics: resolution.diagnostics.map(withoutSpecLocation) };
  if (file !== undefined) {
    const hinted = globMatcher(file);
    if (!resolved.files.some((f) => f === file || hinted(f))) {
      return {
        diagnostics: [
          createDiagnostic("CS0201", {
            spec: spec.id,
            message: `${symbol} is not declared in ${file}; it is in ${resolved.files.join(", ")}`,
            expected: `${symbol} in ${file}`,
            actual: resolved.files,
            suggestions: [{ message: "fix --file, or leave it out" }],
          }),
        ],
      };
    }
  }

  const binding = scaffold(probe.id, symbol, resolved.symbol, file);
  const existing = readYaml(spec.source.frontmatter.text, ["bindings"]);
  const text = Array.isArray(existing)
    ? applyPatch(spec.source, [{ op: "set", path: ["bindings", existing.length], value: binding }])
    : applyPatch(spec.source, [{ op: "set", path: ["bindings"], value: [binding] }]);
  return {
    text,
    binding,
    resolved: `${resolved.file.path}#${resolved.symbol.qualifiedName}`,
    diagnostics: [],
  };
}

/** The default binding id (the symbol's last segment), made unique in the spec. */
function uniqueId(symbol: string, used: ReadonlySet<string>): string {
  const base = symbol.split("#").pop()!.split(".").pop() || symbol;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

const paramType = (p: ParamFact): string => p.type?.text ?? "*";

/** The binding of a declaration: kind, bases, constructor dependencies and public members. */
function scaffold(
  id: string,
  symbol: string,
  declaration: SymbolFact,
  file: string | undefined,
): Record<string, unknown> {
  const binding: Record<string, unknown> = { id, symbol, kind: declaration.kind };
  if (file !== undefined) binding.file = file;
  if (declaration.exported) binding.exported = true;
  if (declaration.bases.length > 0) binding.implements = declaration.bases.map((b) => b.text);
  if (declaration.attributes.length > 0) {
    binding.attributes = [...new Set(declaration.attributes.map((a) => a.name))];
  }
  if (declaration.kind === "function" && declaration.params) {
    // A function binding has no members; its signature is kept by the drift fingerprint.
    return binding;
  }
  const ctor = declaration.members.find(
    (m) => m.kind === "constructor" && (m.params ?? []).some((p) => p.type),
  );
  if (ctor) {
    // `constructor.requires` (the key is spelled out: `binding.constructor` is Object's).
    binding[CONSTRUCTOR] = {
      requires: (ctor.params ?? []).flatMap((p) => (p.type ? [p.type.text] : [])),
    };
  }
  const visible = declaration.members.filter(
    (m) =>
      MEMBERS.has(m.kind) &&
      m.kind !== "constructor" &&
      !m.name.startsWith("#") &&
      !m.modifiers.some((x) => HIDDEN.has(x)),
  );
  const counts = new Map<string, number>();
  for (const m of visible) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const members: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const m of visible) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    const member: Record<string, unknown> = { name: m.name, kind: m.kind };
    // Overloads share a name: the binding names the member, the fingerprint keeps the signatures.
    if (counts.get(m.name) === 1) {
      if (m.params !== undefined) member.params = m.params.map(paramType);
      if (m.returns !== undefined) member.returns = m.returns.text;
    }
    members.push(member);
  }
  if (members.length > 0) binding.members = members;
  return binding;
}
