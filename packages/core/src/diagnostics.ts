/**
 * Diagnostics (plan §D12, ADR-011): every problem CatSpec reports has a stable `CSxxxx` code, a
 * severity, a location and a message. The registry below is the single source of the codes: a
 * code that isn't registered can't be emitted, and the docs are generated from it.
 */

export type Severity = "error" | "warning" | "info";

export interface CodeInfo {
  /** Default severity; a check may lower or raise it (config, spec status, plan §D8). */
  severity: Severity;
  title: string;
  /** Reference text for the diagnostics docs: what the code means and how to fix it. */
  docs: string;
}

/** The code registry. Codes are never reused and their meaning never changes (ADR-011). */
export const CODES = {
  CS0101: {
    severity: "error",
    title: "invalid spec",
    docs:
      "The spec can't be read as a valid spec: the file has no `---` frontmatter or it isn't " +
      "closed, the YAML is invalid, a required field is missing, or a value has the wrong type or " +
      "isn't one of the allowed values. The message names the field and the allowed values. Fix " +
      "the frontmatter at the reported line.",
  },
  CS0102: {
    severity: "warning",
    title: "unknown key",
    docs:
      "A top-level frontmatter key that CatSpec doesn't know. It is ignored, so teams can keep " +
      "their own metadata in the spec. Check the spelling if it was meant to be a CatSpec key.",
  },
  CS0103: {
    severity: "error",
    title: "duplicate id",
    docs:
      "Spec ids must be unique across the repository, and binding and rule ids unique within " +
      "their spec. Rename one of them; the message names every place that uses the id.",
  },
  CS0104: {
    severity: "error",
    title: "unknown dependency",
    docs:
      "`depends_on` names a spec id that doesn't exist. Fix the id (the message suggests close " +
      "matches) or add the missing spec.",
  },
  CS0105: {
    severity: "error",
    title: "dependency cycle",
    docs:
      "The `depends_on` relations form a cycle, so no spec in it can ever be started. The message " +
      "shows the full cycle (`a → b → c → a`); remove one of its dependencies.",
  },
  CS0106: {
    severity: "warning",
    title: "spec outside a feature folder",
    docs:
      "With `layout: feature-folders`, every `*.spec.md` lives directly in `docs/spec/<feature>/`, " +
      "and the architecture spec at the path in `specs.architecture`. Move the file as suggested, " +
      "or set `layout: free` in `catspec.yaml` if the repository uses another layout.",
  },
  CS0107: {
    severity: "error",
    title: "architecture spec missing or ambiguous",
    docs:
      "Exactly one file must match `specs.architecture` (default " +
      "`docs/architecture/adr/*-adr.md`). Create it with `catspec init`, remove the extra " +
      "matches, or change `specs.architecture` in `catspec.yaml`.",
  },
  CS0110: {
    severity: "error",
    title: "unknown reference",
    docs:
      "The spec body references `[rule:<id>]` or `[binding:<id>]`, but the frontmatter has no " +
      "rule or binding with that id. Fix the reference or add the rule or binding.",
  },
  CS0111: {
    severity: "warning",
    title: "unenforced prose invariant",
    docs:
      "A bullet under a `Contracts` or `Invariants` heading has no `[rule:<id>]` or " +
      "`[binding:<id>]` reference, so nothing checks it. Add a rule (a `manual` rule if it can't " +
      "be checked from code) and reference it. Controlled by `enforcement.unenforced_prose`.",
  },
  CS0112: {
    severity: "error",
    title: "unknown ADR id",
    docs:
      "A rule's `adr` field names a decision that isn't in the architecture spec's ADR log " +
      "(a `## ADR-NNN: <title>` heading). Fix the id or add the decision to the log.",
  },
  CS0130: {
    severity: "error",
    title: "invalid query",
    docs:
      "A `query` rule's Tree-sitter query doesn't compile for its language (for example unbalanced " +
      "parentheses or an unknown node type), or no language adapter is installed for its `lang`. " +
      "Queries are compiled when the specs load, before any code is read. Fix the query at the " +
      "reported line.",
  },
  CS0201: {
    severity: "error",
    title: "binding not found",
    docs:
      "No declaration in the code matches the binding's `symbol` (and `kind`). CatSpec looks in " +
      "the files of the `file` hint first, then in every source file, so a moved file is still " +
      "found. The message suggests close names of the same kind, in the hinted files first. Fix " +
      "the symbol, restore the code, or run `catspec sync` after a rename.",
  },
  CS0202: {
    severity: "error",
    title: "binding ambiguous",
    docs:
      "More than one declaration matches the binding's `symbol` and they aren't C# `partial` " +
      "parts of one type. The message lists every location. Qualify the symbol " +
      "(`Namespace.Type` or `path/to/module#Name`) or add a `file` hint.",
  },
  CS0203: {
    severity: "error",
    title: "member missing",
    docs:
      "The bound declaration has no member with the name a `members` entry requires. The message " +
      "suggests the closest existing members with their location. Add the member, rename it back, " +
      "mark the entry `optional: true`, or update the spec.",
  },
  CS0204: {
    severity: "error",
    title: "base type missing",
    docs:
      "The bound declaration doesn't directly extend or implement a type listed in `implements` " +
      "or `extends`. Types match by qualified-name suffix and generic arguments. Add the base " +
      "type or update the spec.",
  },
  CS0205: {
    severity: "error",
    title: "signature mismatch",
    docs:
      "A member exists but its kind, parameter types, return type or modifiers differ from the " +
      "spec. The message shows the expected and the found signature. `*` in `params` matches any " +
      "type.",
  },
  CS0206: {
    severity: "error",
    title: "attribute missing",
    docs:
      "The declaration or member lacks a C# attribute or TypeScript decorator that the spec " +
      "requires in `attributes`. Names match without a trailing `Attribute`; arguments are " +
      "compared only when the spec gives them.",
  },
  CS0207: {
    severity: "error",
    title: "constructor dependency missing",
    docs:
      "No constructor of the bound class takes every type in `constructor.requires` (dependency " +
      "injection). The message names the missing types for the closest constructor.",
  },
  CS0208: {
    severity: "error",
    title: "visibility or export mismatch",
    docs:
      "`exported` requires the declaration to be exported (TypeScript) or `public` (C#), or not, " +
      "or a member lacks a required visibility modifier (`public`, `private`, `protected`, " +
      "`internal`).",
  },
  CS0220: {
    severity: "warning",
    title: "unresolvable",
    docs:
      "CatSpec can't decide the check from syntax alone, for example a base type that is a type " +
      "alias, a parameter without a type annotation, or a class without its own constructor that " +
      "inherits one. It is never reported as a failure of the contract; its severity is " +
      "`enforcement.unresolvable` (`warn` or `error`). Write the type explicitly to make it " +
      "checkable.",
  },
  CS0400: {
    severity: "info",
    title: "waived",
    docs:
      "A rule violation covered by a waiver (`waivers` in the spec, with a reason and an " +
      "optional `until` date). It doesn't fail the check. The message keeps the original code " +
      "and text.",
  },
  CS0401: {
    severity: "error",
    title: "waiver expired",
    docs:
      "A waiver's `until` date has passed. The violations it covered are reported again. Fix " +
      "them and remove the waiver, or extend `until` with a reason.",
  },
  CS0502: {
    severity: "error",
    title: "dependencies not satisfied",
    docs:
      "`catspec status` refuses the transition: `ready` needs every `depends_on` spec to exist, " +
      "`in-progress` and `implemented` need them `implemented` with passing contracts. The " +
      "message names each dependency and why. `--force` skips this gate.",
  },
  CS0601: {
    severity: "error",
    title: "forbidden call",
    docs:
      "A `forbid_call` rule matched a call in its scope (`within` a binding or member, the " +
      "spec's files, or `paths`). `*` in the pattern matches any text. Remove the call or add a " +
      "waiver with a reason.",
  },
  CS0602: {
    severity: "error",
    title: "required call missing",
    docs: "A `require_call` rule found no matching call in its scope. Add the call.",
  },
  CS0603: {
    severity: "error",
    title: "forbidden import",
    docs:
      "A file matching the rule's `from` imports a module that `forbid_import` forbids, or that " +
      "`allow_import_only` doesn't allow. Relative imports are resolved to repository paths " +
      "before they are matched. Remove the import or move the code.",
  },
  CS0604: {
    severity: "error",
    title: "naming rule violated",
    docs:
      "A declaration whose kind and name match a `naming` rule doesn't satisfy its " +
      "`implements`, `extends`, `attributes` or `in_path` requirement.",
  },
  CS0605: {
    severity: "error",
    title: "symbol must not exist",
    docs:
      "A `must_not_exist` rule found a declaration it forbids (usually a deprecated API). Remove " +
      "it or rename it.",
  },
  CS0610: {
    severity: "error",
    title: "query match",
    docs:
      "A `query` rule with `expect: absent` matched, or one with `expect: present` found " +
      "nothing, in its scope.",
  },
  CS0620: {
    severity: "error",
    title: "test missing",
    docs:
      "A `test` rule names a test symbol that doesn't exist in the code. Write the test or fix " +
      "the symbol.",
  },
  CS0621: {
    severity: "error",
    title: "test failed",
    docs:
      "With `--run-tests`, the `tests.command` of `catspec.yaml` failed for a `test` rule. The " +
      "command runs without a shell; `{test}` in it is replaced with the test symbol.",
  },
  CS0901: {
    severity: "warning",
    title: "parse error in file",
    docs:
      "A source file has a syntax error at the reported location. CatSpec still uses the " +
      "declarations it could read before and after the error, so results for that file may be " +
      "incomplete. Fix the syntax error.",
  },
} as const satisfies Record<string, CodeInfo>;

export type DiagnosticCode = keyof typeof CODES;

export const isRegisteredCode = (code: string): code is DiagnosticCode =>
  Object.prototype.hasOwnProperty.call(CODES, code);

/** A position in a file. Lines and columns are 1-based; `file` is relative to the repo root. */
export interface Location {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/** A frontmatter edit, see `applyPatch` (spec-editor.ts). */
export type PatchPath = (string | number)[];
export type PatchOp =
  { op: "set"; path: PatchPath; value: unknown } | { op: "delete"; path: PatchPath };

/** A proposed edit of one spec file. */
export interface SpecPatch {
  file: string;
  ops: PatchOp[];
}

export interface Suggestion {
  message: string;
  patch?: SpecPatch;
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  /** Id of the spec the diagnostic is about. */
  spec?: string;
  /** Where in the spec file: the binding, rule or key in the frontmatter, or the body line. */
  specLocation?: Location;
  /** Where in the code. */
  codeLocation?: Location;
  /** A human sentence that includes what was expected and what was found. */
  message: string;
  expected?: unknown;
  actual?: unknown;
  suggestions?: Suggestion[];
  ruleId?: string;
  bindingId?: string;
  /** The contract item checked, e.g. `binding:auth.login` or `rule:no-console` (ratchet, F5). */
  item?: string;
}

export type DiagnosticInit = Omit<Diagnostic, "code" | "severity"> & { severity?: Severity };

/** Creates a diagnostic with the registered default severity unless `severity` is given. */
export function createDiagnostic(code: DiagnosticCode, init: DiagnosticInit): Diagnostic {
  if (!isRegisteredCode(code)) {
    throw new Error(`unregistered diagnostic code ${String(code)}; add it to CODES`);
  }
  const { severity, ...rest } = init;
  return { code, severity: severity ?? CODES[code].severity, ...rest };
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Sorts diagnostics by file, line, column, then code, so output is deterministic. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const key = (d: Diagnostic): Location =>
    d.specLocation ?? d.codeLocation ?? { file: "", line: 0, column: 0 };
  return [...diagnostics].sort((a, b) => {
    const la = key(a);
    const lb = key(b);
    return (
      compareStrings(la.file, lb.file) ||
      la.line - lb.line ||
      la.column - lb.column ||
      compareStrings(a.code, b.code) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compareStrings(a.message, b.message)
    );
  });
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0 };
  for (const d of diagnostics) {
    if (d.severity === "error") counts.errors++;
    else if (d.severity === "warning") counts.warnings++;
    else counts.infos++;
  }
  return counts;
}

/** Locale-independent string comparison, for deterministic ordering on every platform. */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
