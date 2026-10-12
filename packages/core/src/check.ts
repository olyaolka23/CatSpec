/**
 * The check pipeline (plan §D11.3), PBIs `status-and-waivers` and `check-command`: resolves the
 * bindings of each spec, evaluates contracts and rules, applies the enforcement matrix by spec
 * status (§D8) and the waivers (§D6.5), and records every contract item's result. Architecture
 * rules apply to every source file unless the architecture spec is a draft (§D6.4).
 */
import { execFile } from "node:child_process";

import { SymbolTable, type Codebase } from "./codebase.js";
import { bindingItems, evaluateContract } from "./contracts.js";
import {
  createDiagnostic,
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticCode,
} from "./diagnostics.js";
import { parseErrorDiagnostics, type FileFacts, type LanguageAdapter } from "./facts.js";
import type { SpecModel } from "./load.js";
import { resolveBinding, type ResolvedBinding } from "./resolve.js";
import { evaluateRule, type TestRun } from "./rules.js";
import { specLocation, type Spec } from "./spec.js";
import { globMatcher, listOf } from "./util.js";

/**
 * `status`: enforcement by spec status (§D8): draft, ready and deprecated specs aren't checked,
 * failures of in-progress specs are warnings. `full`: every selected spec is checked as if it
 * were implemented (`check --spec`, `status … implemented`, `coverage`).
 */
export type CheckMode = "status" | "full";

export interface CheckOptions {
  /** Only these spec ids; repository-wide diagnostics are left out. */
  specs?: readonly string[];
  mode?: CheckMode;
  /** Today, for waiver expiry. */
  now?: Date;
  /** Runs a test rule's test (`--run-tests`). */
  runTest?: (symbol: string) => Promise<TestRun>;
}

/** The result of one contract item: a binding, a member or a rule. */
export interface ItemResult {
  spec: string;
  /** `binding:<id>`, `binding:<id>.<member>` or `rule:<id>`. */
  item: string;
  /** False for `manual` rules: nothing checks them (ADR-007). */
  enforceable: boolean;
  /** Checked and nothing failed (an active waiver counts as passing); false for manual rules. */
  passed: boolean;
}

export interface CheckResult {
  /** The specs whose contracts were evaluated. */
  checked: Spec[];
  items: ItemResult[];
  /** Spec diagnostics (`--specs-only`) and code diagnostics, sorted. */
  diagnostics: Diagnostic[];
  /** Resolved bindings by spec id, then binding id. */
  resolved: Map<string, Map<string, ResolvedBinding>>;
}

/** True when a spec's contracts are evaluated in `status` mode (§D6.4, §D8). */
export function isEnforced(spec: Spec): boolean {
  if (spec.type === "architecture") return spec.status !== "draft";
  return spec.status === "in-progress" || spec.status === "implemented";
}

/** CS0130: query rules whose query doesn't compile, checked when the specs load. */
export function queryDiagnostics(
  model: SpecModel,
  adapter: (lang: string) => LanguageAdapter | undefined,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const spec of model.specs.byFile.values()) {
    for (const rule of spec.rules) {
      if (rule.class !== "query") continue;
      const lang = adapter(rule.lang);
      const error = !lang
        ? `no language adapter for "${rule.lang}"`
        : !lang.checkQuery
          ? `the ${rule.lang} adapter doesn't support query rules`
          : lang.checkQuery(rule.query);
      if (error === undefined) continue;
      diagnostics.push(
        createDiagnostic("CS0130", {
          spec: spec.id,
          ruleId: rule.id,
          item: `rule:${rule.id}`,
          specLocation: specLocation(spec.source, ["rules", rule.index, "query"]),
          message: `rule "${rule.id}": invalid ${rule.lang} query: ${error}`,
          actual: rule.query,
          suggestions: [{ message: "fix the query; check its parentheses and node types" }],
        }),
      );
    }
  }
  return diagnostics;
}

/** Runs the check: spec diagnostics of `model` plus the evaluation of the code. */
export async function checkCode(
  model: SpecModel,
  codebase: Codebase,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const mode = options.mode ?? "status";
  const now = options.now ?? new Date();
  const table = new SymbolTable(codebase.files);
  const selected = options.specs ? new Set(options.specs) : undefined;
  const specs = model.specs
    .all()
    .filter((s) => (selected ? selected.has(s.id) : true))
    .filter(
      (s) =>
        s.valid &&
        (mode === "full" ? selected !== undefined || s.status !== "deprecated" : isEnforced(s)),
    );

  const specDiagnostics = [
    ...model.diagnostics,
    ...queryDiagnostics(model, (lang) => codebase.adapter(lang)),
  ].filter((d) => !selected || (d.spec !== undefined && selected.has(d.spec)));

  const diagnostics: Diagnostic[] = [];
  const items: ItemResult[] = [];
  const resolvedBySpec = new Map<string, Map<string, ResolvedBinding>>();
  const testRuns = new Map<string, Promise<TestRun>>();
  const runTest = options.runTest
    ? (symbol: string): Promise<TestRun> => {
        let run = testRuns.get(symbol);
        if (!run) testRuns.set(symbol, (run = options.runTest!(symbol)));
        return run;
      }
    : undefined;
  const failedSpecs = new Set(
    specDiagnostics.filter((d) => d.code === "CS0130").map((d) => `${d.spec}\0${d.ruleId}`),
  );

  for (const spec of specs) {
    const raw: Diagnostic[] = [];
    const resolved = new Map<string, ResolvedBinding>();
    for (const binding of spec.bindings) {
      const resolution = resolveBinding(spec, binding, table);
      raw.push(...resolution.diagnostics);
      if (!resolution.resolved) continue;
      resolved.set(binding.id, resolution.resolved);
      raw.push(
        ...evaluateContract(spec, resolution.resolved, {
          table,
          adapter: codebase.adapter(resolution.resolved.file.lang),
          unresolvable: model.config.enforcement.unresolvable,
        }),
      );
    }
    resolvedBySpec.set(spec.id, resolved);
    const files = specFiles(spec, resolved, codebase.files);
    for (const rule of spec.rules) {
      if (failedSpecs.has(`${spec.id}\0${rule.id}`)) continue;
      raw.push(
        ...(await evaluateRule(spec, rule, {
          codebase,
          table,
          bindings: resolved,
          files,
          ...(runTest ? { runTest } : {}),
        })),
      );
    }

    const enforced = enforce(spec, raw, mode, now);
    diagnostics.push(...enforced);

    const unresolved = new Set(spec.bindings.filter((b) => !resolved.has(b.id)).map((b) => b.id));
    const failing = new Set(
      enforced.filter((d) => d.item && d.severity !== "info").map((d) => d.item!),
    );
    for (const binding of spec.bindings) {
      for (const item of bindingItems(binding)) {
        items.push({
          spec: spec.id,
          item,
          enforceable: true,
          passed: !unresolved.has(binding.id) && !failing.has(item),
        });
      }
    }
    for (const rule of spec.rules) {
      const item = `rule:${rule.id}`;
      const within = "within" in rule ? rule.within : undefined;
      const blocked =
        within !== undefined &&
        [...unresolved].some((id) => within === id || within.startsWith(`${id}.`));
      items.push({
        spec: spec.id,
        item,
        enforceable: rule.class !== "manual",
        passed:
          rule.class !== "manual" &&
          !blocked &&
          !failing.has(item) &&
          !failedSpecs.has(`${spec.id}\0${rule.id}`),
      });
    }
  }

  // Syntax errors of the files the selected specs bind (all files without --spec).
  const boundFiles = new Set(
    [...resolvedBySpec.values()].flatMap((m) => [...m.values()].flatMap((r) => r.files)),
  );
  const parseErrors = codebase.files
    .filter((f) => !selected || boundFiles.has(f.path))
    .flatMap(parseErrorDiagnostics);

  return {
    checked: specs,
    items,
    diagnostics: sortDiagnostics([...specDiagnostics, ...diagnostics, ...parseErrors]),
    resolved: resolvedBySpec,
  };
}

/** Files a spec's rules apply to by default: every source for the architecture spec, else the
 * files of its resolved bindings and its `scope` globs. */
function specFiles(
  spec: Spec,
  resolved: ReadonlyMap<string, ResolvedBinding>,
  files: readonly FileFacts[],
): FileFacts[] {
  if (spec.type === "architecture") return [...files];
  const bound = new Set([...resolved.values()].flatMap((r) => r.files));
  const inScope = spec.scope.length > 0 ? globMatcher(spec.scope) : () => false;
  return files.filter((f) => bound.has(f.path) || inScope(f.path));
}

/** Codes of contract failures, which the status matrix lowers for in-progress specs. */
const isContractFailure = (code: DiagnosticCode): boolean =>
  code.startsWith("CS02") || code.startsWith("CS06");

/** Applies waivers (§D6.5) and the enforcement matrix (§D8) to a spec's raw diagnostics. */
function enforce(spec: Spec, raw: Diagnostic[], mode: CheckMode, now: Date): Diagnostic[] {
  const today = isoDate(now);
  const out: Diagnostic[] = [];
  const active = spec.waivers.filter((w) => w.until === undefined || w.until >= today);
  for (const waiver of spec.waivers) {
    if (waiver.until === undefined || waiver.until >= today) continue;
    out.push(
      createDiagnostic("CS0401", {
        spec: spec.id,
        specLocation: specLocation(spec.source, ["waivers", waiver.index, "until"]),
        ruleId: waiver.rule,
        message: `the waiver for rule "${waiver.rule}" expired on ${waiver.until} (${waiver.reason}); its violations are reported again`,
        expected: `until ≥ ${today}`,
        actual: waiver.until,
        suggestions: [
          { message: "fix the violations and remove the waiver, or extend until with a reason" },
        ],
      }),
    );
  }
  for (const d of raw) {
    const waiver = active.find(
      (w) =>
        d.ruleId === w.rule &&
        (!w.paths || (d.codeLocation !== undefined && globMatcher(w.paths)(d.codeLocation.file))),
    );
    if (waiver) {
      out.push({
        ...d,
        code: "CS0400",
        severity: "info",
        message: `waived${waiver.until ? ` until ${waiver.until}` : ""} (${waiver.reason}): ${d.code} ${d.message}`,
        actual: d.code,
      });
      continue;
    }
    const lowered =
      mode === "status" &&
      spec.type !== "architecture" &&
      spec.status === "in-progress" &&
      d.severity === "error" &&
      isContractFailure(d.code);
    out.push(lowered ? { ...d, severity: "warning" } : d);
  }
  return out;
}

const isoDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** `tests.command` as arguments: a string is split at whitespace. */
export const testCommandArgs = (command: string | readonly string[]): string[] =>
  typeof command === "string" ? command.trim().split(/\s+/) : [...command];

/**
 * Runs `tests.command` for one test, without a shell (ADR-009): `{test}` in an argument is
 * replaced with the test symbol. The test passes when the command exits with 0.
 */
export function runTestCommand(
  root: string,
  command: string | readonly string[],
  symbol: string,
  timeoutMs = 10 * 60_000,
): Promise<TestRun> {
  const [file, ...args] = testCommandArgs(command).map((a) => a.replaceAll("{test}", symbol));
  const line = [file, ...args].join(" ");
  return new Promise((resolvePromise) => {
    execFile(
      file!,
      args,
      { cwd: root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim().split(/\r?\n/).slice(-20).join("\n");
        resolvePromise({
          passed: !error,
          command: line,
          output: error && !output ? error.message : output,
        });
      },
    );
  });
}

/** Specs a status change depends on, for `catspec status` (§D8). */
export interface StatusGate {
  allowed: boolean;
  diagnostics: Diagnostic[];
}

/**
 * Whether `spec` may move to `target` (§D8): `ready` needs every dependency to exist,
 * `in-progress` and `implemented` need them implemented and passing (CS0502; `force` skips this),
 * and `implemented` needs the spec's own contracts to pass (never forced).
 */
export async function statusGate(
  model: SpecModel,
  codebase: Codebase,
  spec: Spec,
  target: Spec["status"],
  options: { force?: boolean; now?: Date } = {},
): Promise<StatusGate> {
  const diagnostics: Diagnostic[] = [];
  const now = options.now ?? new Date();
  if (
    !options.force &&
    (target === "ready" || target === "in-progress" || target === "implemented")
  ) {
    const problems: string[] = [];
    for (const dep of spec.dependsOn) {
      const other = model.specs.get(dep);
      if (!other) {
        problems.push(`${dep} does not exist`);
        continue;
      }
      if (target === "ready") continue;
      if (other.status !== "implemented") {
        problems.push(`${dep} is ${other.status}, not implemented`);
        continue;
      }
      const result = await checkCode(model, codebase, { specs: [dep], mode: "full", now });
      if (result.diagnostics.some((d) => d.severity === "error")) {
        problems.push(
          `${dep} is implemented but its contracts fail (run \`catspec check --spec ${dep}\`)`,
        );
      }
    }
    if (problems.length > 0) {
      diagnostics.push(
        createDiagnostic("CS0502", {
          spec: spec.id,
          specLocation: specLocation(spec.source, ["depends_on"]),
          message: `"${spec.id}" can't become ${target}: ${listOf(problems)}`,
          expected:
            target === "ready"
              ? "every dependency exists"
              : "every dependency implemented and passing",
          actual: problems,
          suggestions: [{ message: "finish the dependencies first, or use --force" }],
        }),
      );
    }
  }
  if (target === "implemented") {
    const result = await checkCode(model, codebase, { specs: [spec.id], mode: "full", now });
    diagnostics.push(...result.diagnostics.filter((d) => d.severity === "error"));
  }
  return {
    allowed: !diagnostics.some((d) => d.severity === "error"),
    diagnostics: sortDiagnostics(diagnostics),
  };
}
