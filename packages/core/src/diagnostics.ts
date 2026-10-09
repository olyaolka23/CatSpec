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
