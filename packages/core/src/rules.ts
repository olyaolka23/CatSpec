/**
 * Rule evaluation (plan §D6), PBIs `structural-rules`, `query-and-test-rules` and
 * `architecture-rules`: the structural catalogue (§D6.2), raw Tree-sitter `query` rules (§D6.3)
 * through the adapter, and `test` rules. A rule's scope is its `within` binding or member, else
 * the spec's files (all sources for the architecture spec), narrowed by `paths`.
 */
import { builtinModules } from "node:module";
import { posix } from "node:path";

import {
  codeLocation,
  rangeContains,
  type Codebase,
  type SymbolEntry,
  type SymbolTable,
} from "./codebase.js";
import { attributeMatches } from "./contracts.js";
import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type Location,
} from "./diagnostics.js";
import type { CallFact, FileFacts, Range } from "./facts.js";
import { typePatternMatches, wildcard, qualifiedNameMatches } from "./match.js";
import type { ResolvedBinding } from "./resolve.js";
import type { Rule, StructuralRule } from "./spec-schema.js";
import { specLocation, type Spec } from "./spec.js";
import { globMatcher, listOf } from "./util.js";

/** The result of running the test command for one test. */
export interface TestRun {
  passed: boolean;
  /** The command line that ran. */
  command: string;
  /** The end of the command's output, for the report. */
  output: string;
}

export interface RuleContext {
  codebase: Codebase;
  table: SymbolTable;
  /** The spec's resolved bindings, by id. */
  bindings: ReadonlyMap<string, ResolvedBinding>;
  /** The files the spec's rules apply to without `within`. */
  files: readonly FileFacts[];
  /** Runs a test rule's test (`check --run-tests`); undefined when tests aren't run. */
  runTest?: (symbol: string) => Promise<TestRun>;
}

/** The code a rule looks at: files, and inside them only `ranges` when `within` is set. */
interface Scope {
  files: FileFacts[];
  ranges?: Map<string, Range[]>;
}

/** Evaluates one rule of a spec. `manual` rules are never evaluated (ADR-007). */
export async function evaluateRule(
  spec: Spec,
  rule: Rule,
  context: RuleContext,
): Promise<Diagnostic[]> {
  if (rule.class === "manual") return [];
  const scope = scopeOf(rule, context);
  if (!scope) return []; // `within` names a binding that didn't resolve; CS0201 says why.
  const diagnostics: Diagnostic[] = [];
  const report = (
    code: DiagnosticCode,
    message: string,
    extra: Partial<Diagnostic> & { codeLocation?: Location } = {},
    path: (string | number)[] = [],
  ): void => {
    diagnostics.push(
      createDiagnostic(code, {
        spec: spec.id,
        specLocation: specLocation(spec.source, ["rules", rule.index, ...path]),
        ruleId: rule.id,
        item: `rule:${rule.id}`,
        message: rule.message ? `${rule.message} (${message})` : message,
        ...extra,
      }),
    );
  };
  const inScope = (path: string, range: Range): boolean => {
    const ranges = scope.ranges?.get(path);
    return !scope.ranges || (ranges ?? []).some((r) => rangeContains(r, range));
  };
  const adr = rule.adr ? `, ${rule.adr}` : "";

  if (rule.class === "structural") {
    evaluateStructural(rule, scope, context.table, inScope, report, adr);
  } else if (rule.class === "query") {
    const adapter = context.codebase.adapter(rule.lang);
    if (!adapter?.runQuery || adapter.checkQuery?.(rule.query) !== undefined) return []; // CS0130
    const hits: { path: string; range: Range }[] = [];
    for (const file of scope.files) {
      if (file.lang !== rule.lang || file.skipped !== undefined) continue;
      const source = await context.codebase.source(file.path);
      for (const range of adapter.runQuery(source, rule.query)) {
        if (inScope(file.path, range)) hits.push({ path: file.path, range });
      }
    }
    if (rule.expect === "absent") {
      for (const hit of hits) {
        report("CS0610", `query rule "${rule.id}" matched; expected no match${adr}`, {
          codeLocation: codeLocation(hit.path, hit.range),
          expected: "absent",
          actual: "match",
          suggestions: [{ message: "change the code so the query no longer matches" }],
        });
      }
    } else if (hits.length === 0) {
      report("CS0610", `query rule "${rule.id}" found no match; expected at least one${adr}`, {
        expected: "present",
        actual: "no match",
        suggestions: [{ message: "add the code the query looks for" }],
      });
    }
  } else {
    const { symbol, lang } = rule.test;
    const found = context.table.find(symbol).filter((e) => !lang || e.file.lang === lang);
    if (found.length === 0) {
      report(
        "CS0620",
        `test ${symbol} of rule "${rule.id}" not found`,
        {
          expected: symbol,
          actual: "nothing",
          suggestions: [{ message: `write the test ${symbol}, or fix the test symbol` }],
        },
        ["test", "symbol"],
      );
    } else if (context.runTest) {
      const run = await context.runTest(symbol);
      if (!run.passed) {
        report(
          "CS0621",
          `test ${symbol} of rule "${rule.id}" failed: ${run.command}`,
          {
            codeLocation: codeLocation(found[0]!.file.path, found[0]!.symbol.nameRange),
            expected: "pass",
            actual: run.output,
            suggestions: [{ message: `run ${run.command} and fix the test or the code` }],
          },
          ["test", "symbol"],
        );
      }
    }
  }
  return diagnostics;
}

type Report = (
  code: DiagnosticCode,
  message: string,
  extra?: Partial<Diagnostic> & { codeLocation?: Location },
  path?: (string | number)[],
) => void;

function evaluateStructural(
  rule: StructuralRule,
  scope: Scope,
  table: SymbolTable,
  inScope: (path: string, range: Range) => boolean,
  report: Report,
  adr: string,
): void {
  if (rule.forbid_call !== undefined || rule.require_call !== undefined) {
    const pattern = (rule.forbid_call ?? rule.require_call)!;
    const matches = wildcard(pattern);
    const calls: { file: FileFacts; call: CallFact; name: string }[] = [];
    for (const file of scope.files) {
      for (const call of file.calls) {
        const name = calleeNames(call.callee, file).find(matches);
        if (name !== undefined && inScope(file.path, call.range)) calls.push({ file, call, name });
      }
    }
    if (rule.forbid_call !== undefined) {
      for (const { file, call } of calls) {
        report(
          "CS0601",
          `call to ${call.callee} is forbidden by rule "${rule.id}" (${pattern}${adr})`,
          {
            codeLocation: codeLocation(file.path, call.range),
            expected: `no call matching ${pattern}`,
            actual: call.callee,
            suggestions: [
              { message: `remove the call to ${call.callee}, or add a waiver with a reason` },
            ],
          },
          ["forbid_call"],
        );
      }
    } else if (calls.length === 0) {
      report(
        "CS0602",
        `no call matching ${pattern} in the scope of rule "${rule.id}"${adr ? ` (${adr.slice(2)})` : ""}`,
        {
          expected: `a call matching ${pattern}`,
          actual: "no such call",
          suggestions: [{ message: `add a call matching ${pattern}` }],
        },
        ["require_call"],
      );
    }
    return;
  }

  const imports = rule.forbid_import ?? rule.allow_import_only;
  if (imports) {
    const from = globMatcher(imports.from);
    const to = globMatcher(imports.to);
    const forbid = rule.forbid_import !== undefined;
    const key = forbid ? "forbid_import" : "allow_import_only";
    for (const file of scope.files) {
      if (!from(file.path)) continue;
      for (const imp of file.imports) {
        if (!inScope(file.path, imp.range)) continue;
        const targets = importTargets(file.path, imp.module);
        const listed = targets.some(to);
        const violation = forbid ? listed : !listed && !isStdlib(imp.module, file.lang);
        if (!violation) continue;
        report(
          "CS0603",
          forbid
            ? `${file.path} imports ${imp.module}; rule "${rule.id}" forbids imports from ${listOf(imports.from)} to ${listOf(imports.to)}${adr}`
            : `${file.path} imports ${imp.module}; rule "${rule.id}" allows files in ${listOf(imports.from)} to import only ${listOf(imports.to)}${adr}`,
          {
            codeLocation: codeLocation(file.path, imp.range),
            expected: forbid
              ? `no import of ${listOf(imports.to)}`
              : `imports of ${listOf(imports.to)} only`,
            actual: imp.module,
            suggestions: [
              { message: `remove the import of ${imp.module} from ${file.path}, or move the code` },
            ],
          },
          [key],
        );
      }
    }
    return;
  }

  if (rule.naming) {
    const naming = rule.naming;
    const nameMatches = wildcard(naming.name);
    const inPath = naming.in_path ? globMatcher(naming.in_path) : undefined;
    for (const { symbol, file } of entriesIn(scope, table, inScope)) {
      if (naming.kind ? symbol.kind !== naming.kind : symbol.kind === "constructor") continue;
      if (!nameMatches(symbol.name)) continue;
      const problems: string[] = [];
      for (const type of naming.implements ?? []) {
        if (!symbol.bases.some((b) => typePatternMatches(type, b)))
          problems.push(`implement ${type}`);
      }
      if (
        naming.extends !== undefined &&
        !symbol.bases.some((b) => typePatternMatches(naming.extends!, b))
      ) {
        problems.push(`extend ${naming.extends}`);
      }
      for (const attribute of naming.attributes ?? []) {
        if (!symbol.attributes.some((a) => attributeMatches(attribute, a)))
          problems.push(`have attribute ${attribute}`);
      }
      if (inPath && !inPath(file.path)) problems.push(`live in ${listOf(naming.in_path!)}`);
      if (problems.length === 0) continue;
      report(
        "CS0604",
        `${symbol.kind} ${symbol.qualifiedName} must ${problems.join(", ")} (rule "${rule.id}": ${naming.name}${adr})`,
        {
          codeLocation: codeLocation(file.path, symbol.nameRange),
          expected: problems,
          actual: symbol.bases.map((b) => b.text),
          suggestions: [{ message: `make ${symbol.name} ${problems.join(", ")}, or rename it` }],
        },
        ["naming"],
      );
    }
    return;
  }

  if (rule.must_not_exist) {
    const { symbol: pattern, kind } = rule.must_not_exist;
    for (const { symbol, file } of entriesIn(scope, table, inScope)) {
      if (kind ? symbol.kind !== kind : symbol.kind === "constructor") continue;
      if (!qualifiedNameMatches(pattern, symbol.qualifiedName)) continue;
      report(
        "CS0605",
        `${symbol.kind} ${symbol.qualifiedName} must not exist (rule "${rule.id}"${adr})`,
        {
          codeLocation: codeLocation(file.path, symbol.nameRange),
          expected: `no ${kind ?? "symbol"} ${pattern}`,
          actual: symbol.qualifiedName,
          suggestions: [{ message: `remove or rename ${symbol.qualifiedName}` }],
        },
        ["must_not_exist"],
      );
    }
  }
}

/** The declarations in a scope. */
function entriesIn(
  scope: Scope,
  table: SymbolTable,
  inScope: (path: string, range: Range) => boolean,
): SymbolEntry[] {
  const files = new Set(scope.files.map((f) => f.path));
  return table.entries.filter(
    (e) => files.has(e.file.path) && inScope(e.file.path, e.symbol.range),
  );
}

/** The files and ranges a rule applies to; undefined when its `within` binding didn't resolve. */
function scopeOf(rule: Rule, context: RuleContext): Scope | undefined {
  const paths = rule.paths ? globMatcher(rule.paths) : undefined;
  const narrow = (files: readonly FileFacts[]): FileFacts[] =>
    paths ? files.filter((f) => paths(f.path)) : [...files];
  const within = "within" in rule ? rule.within : undefined;
  if (within === undefined) return { files: narrow(context.files) };
  const bindingId = context.bindings.has(within)
    ? within
    : [...context.bindings.keys()]
        .filter((id) => within.startsWith(`${id}.`))
        .sort((a, b) => b.length - a.length)[0];
  const resolved = bindingId === undefined ? undefined : context.bindings.get(bindingId);
  if (!resolved) return undefined;
  const memberName =
    within.length > bindingId!.length ? within.slice(bindingId!.length + 1) : undefined;
  // Each part of a C# partial type is in its own file, with its own members.
  const ranges = new Map<string, Range[]>();
  for (const part of resolved.parts) {
    const targets = memberName
      ? part.symbol.members.filter((m) => m.name === memberName)
      : [part.symbol];
    if (targets.length === 0) continue;
    ranges.set(part.file.path, [
      ...(ranges.get(part.file.path) ?? []),
      ...targets.map((t) => t.range),
    ]);
  }
  if (ranges.size === 0) return undefined; // the missing member is CS0203
  const files = context.codebase.files.filter((f) => ranges.has(f.path));
  return { files: narrow(files), ranges };
}

/**
 * Names a call matches by: the callee as written, and with its first segment resolved through
 * the file's imports (`exec` imported from `node:child_process` is also `child_process.exec`).
 * An import of every name without an alias (C# `using System;`, `using static System.Console;`)
 * also prefixes the callee with the module. In C#, names starting with `System.` also match
 * without it, as types do.
 */
export function calleeNames(callee: string, file: FileFacts): string[] {
  const names = [callee];
  const [head, ...rest] = callee.split(".");
  for (const imp of file.imports) {
    const module = imp.module.replace(/^node:/, "");
    for (const imported of imp.names) {
      if (imported.name === "*" && imported.alias === undefined && imp.kind !== "reexport") {
        names.push(`${module}.${callee}`);
        continue;
      }
      if ((imported.alias ?? imported.name) !== head) continue;
      const name =
        imported.name === "*" || imported.name === "default"
          ? [module, ...rest]
          : [module, imported.name, ...rest];
      names.push(name.join("."));
    }
  }
  if (file.lang === "csharp") {
    for (const name of [...names]) if (name.startsWith("System.")) names.push(name.slice(7));
  }
  return names;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * What an import can be matched against: a relative specifier as a repository path (with and
 * without an extension, `./x.js` also as `x.ts`), a package specifier as written, without
 * `node:`, and as its package name.
 */
export function importTargets(fromFile: string, module: string): string[] {
  if (module.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromFile), module));
    const bare = resolved.replace(/\.(?:[mc]?[jt]sx?)$/, "");
    return [
      ...new Set([
        resolved,
        bare,
        ...SOURCE_EXTENSIONS.map((e) => bare + e),
        ...SOURCE_EXTENSIONS.map((e) => `${bare}/index${e}`),
      ]),
    ];
  }
  const name = module.replace(/^node:/, "");
  const segments = name.split("/");
  const pkg = name.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
  return [...new Set([module, name, pkg])];
}

const BUILTINS = new Set(builtinModules);

/** Node.js built-in modules (`fs`, `node:fs`); in C#, the `System` namespaces. */
const isStdlib = (module: string, lang: string): boolean =>
  lang === "csharp"
    ? module === "System" || module.startsWith("System.")
    : module.startsWith("node:") || BUILTINS.has(module.split("/")[0]!);
