/**
 * Reporters for diagnostics (plan §D10, §D12), PBI `diagnostics-core`: `text` for people and
 * `json` for tools. Output is deterministic: diagnostics are sorted and nothing depends on time
 * unless `--verbose` asks for the duration.
 */
import {
  compareStrings,
  countDiagnostics,
  sortDiagnostics,
  type CoverageReport,
  type Diagnostic,
  type DiagnosticCounts,
  type ItemResult,
  type Location,
  type Ratio,
  type Severity,
  type Spec,
} from "@catspec/core";

/** Exit codes (plan §D10). */
export const EXIT = { ok: 0, errors: 1, usage: 2, internal: 3 } as const;

/** 1 when any diagnostic is an error, else 0 (warnings and infos never fail a run). */
export const exitCodeFor = (diagnostics: readonly Diagnostic[]): number =>
  diagnostics.some((d) => d.severity === "error") ? EXIT.errors : EXIT.ok;

export interface Style {
  red(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const ansi =
  (open: number, close: number) =>
  (text: string): string =>
    `\u001b[${open}m${text}\u001b[${close}m`;

export const COLORS: Style = {
  red: ansi(31, 39),
  yellow: ansi(33, 39),
  green: ansi(32, 39),
  cyan: ansi(36, 39),
  dim: ansi(2, 22),
  bold: ansi(1, 22),
};

const identity = (text: string): string => text;
export const PLAIN: Style = {
  red: identity,
  yellow: identity,
  green: identity,
  cyan: identity,
  dim: identity,
  bold: identity,
};

export interface TextReportOptions {
  style?: Style;
  /** Only errors, no ✔ lines and no summary. */
  quiet?: boolean;
  /** Also print info diagnostics' docs-free details and the duration. */
  verbose?: boolean;
  /** Ids and files of every checked spec, to print ✔ for the ones without diagnostics. */
  specs?: readonly { id: string; file: string }[];
  durationMs?: number;
}

const SYMBOL: Record<Severity | "ok", string> = { error: "✖", warning: "⚠", info: "ℹ", ok: "✔" };

/** Text report, grouped by spec (or by file for diagnostics without a spec). */
export function formatText(
  diagnostics: readonly Diagnostic[],
  options: TextReportOptions = {},
): string {
  const style = options.style ?? PLAIN;
  const shown = sortDiagnostics(
    options.quiet ? diagnostics.filter((d) => d.severity === "error") : diagnostics,
  );
  const colour = (severity: Severity | "ok", text: string): string =>
    severity === "error"
      ? style.red(text)
      : severity === "warning"
        ? style.yellow(text)
        : severity === "info"
          ? style.cyan(text)
          : style.green(text);

  interface Group {
    title: string;
    file: string;
    items: Diagnostic[];
  }
  const groups = new Map<string, Group>();
  for (const d of shown) {
    const file = d.specLocation?.file ?? d.codeLocation?.file ?? "";
    const key = d.spec ? `spec:${d.spec}` : `file:${file}`;
    const group = groups.get(key) ?? { title: d.spec ?? (file || "repository"), file, items: [] };
    group.items.push(d);
    groups.set(key, group);
  }
  if (!options.quiet) {
    for (const spec of options.specs ?? []) {
      if (!groups.has(`spec:${spec.id}`)) {
        groups.set(`spec:${spec.id}`, { title: spec.id, file: spec.file, items: [] });
      }
    }
  }

  const lines: string[] = [];
  const ordered = [...groups.values()].sort(
    (a, b) => compareStrings(a.file, b.file) || compareStrings(a.title, b.title),
  );
  for (const group of ordered) {
    const worst: Severity | "ok" = group.items.some((d) => d.severity === "error")
      ? "error"
      : group.items.some((d) => d.severity === "warning")
        ? "warning"
        : group.items.length > 0
          ? "info"
          : "ok";
    const file = group.file && group.file !== group.title ? `  ${style.dim(group.file)}` : "";
    lines.push(`${colour(worst, SYMBOL[worst])} ${style.bold(group.title)}${file}`);
    for (const d of group.items) {
      const at = d.specLocation ?? d.codeLocation;
      const where =
        at && at.file !== group.file
          ? `${at.file}:${at.line}:${at.column}`
          : at
            ? `${at.line}:${at.column}`
            : "";
      const prefix = `  ${where ? `${style.dim(where)}  ` : ""}`;
      lines.push(`${prefix}${colour(d.severity, d.code)} ${d.message}`);
      const indent = " ".repeat(2 + (where ? where.length + 2 : 0) + d.code.length + 1);
      if (d.specLocation && d.codeLocation) {
        lines.push(`${indent}${style.dim(`at ${locationText(d.codeLocation)}`)}`);
      }
      for (const suggestion of d.suggestions ?? []) {
        lines.push(`${indent}${style.dim(`↳ ${suggestion.message}`)}`);
      }
    }
  }

  if (!options.quiet) {
    const counts = countDiagnostics(diagnostics);
    const specCount = options.specs?.length;
    const duration =
      options.verbose && options.durationMs !== undefined
        ? ` (${Math.round(options.durationMs)} ms)`
        : "";
    lines.push(
      `${summary(counts)}${specCount === undefined ? "" : ` in ${plural(specCount, "spec")}`}${duration}`,
    );
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export const summary = (counts: DiagnosticCounts): string =>
  `${plural(counts.errors, "error")}, ${plural(counts.warnings, "warning")}` +
  (counts.infos > 0 ? `, ${plural(counts.infos, "info")}` : "");

/** JSON report: every diagnostic with its code, severity, locations and message, and a summary. */
export function formatJson(
  diagnostics: readonly Diagnostic[],
  specCount?: number,
  extra: { items?: readonly ItemResult[]; done?: boolean } = {},
): string {
  const counts = countDiagnostics(diagnostics);
  const report = {
    diagnostics: sortDiagnostics(diagnostics),
    summary: { ...counts, ...(specCount === undefined ? {} : { specs: specCount }) },
    ...extra,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

const locationText = (at: Location): string => `${at.file}:${at.line}:${at.column}`;

/** A diagnostic's expected or actual value as one line. */
function valueText(value: unknown): string {
  if (value === undefined) return "-";
  if (typeof value === "string") return value.split(/\r?\n/).join(" ⏎ ");
  if (Array.isArray(value)) return value.length > 0 ? value.map(valueText).join(", ") : "none";
  return JSON.stringify(value);
}

export interface AgentReportInput {
  specs: readonly Spec[];
  items: readonly ItemResult[];
  diagnostics: readonly Diagnostic[];
}

/**
 * The `check --spec` report (plan §D10, analysis F-14): for every failing item what was expected,
 * what was found and how to fix it, then the passing items, a summary, and `DONE` or `NOT DONE` as
 * the last line. Done means no errors.
 */
export function formatAgentReport(input: AgentReportInput, style: Style = PLAIN): string {
  const lines: string[] = [];
  const shown = sortDiagnostics(input.diagnostics.filter((d) => d.severity !== "info"));
  for (const spec of input.specs) {
    lines.push(`${style.bold(`spec ${spec.id}`)}  ${style.dim(`${spec.file} (${spec.status})`)}`);
  }
  for (const d of shown) {
    const mark = d.severity === "error" ? style.red("✖") : style.yellow("⚠");
    const what = d.item ?? d.spec ?? d.specLocation?.file ?? d.codeLocation?.file ?? "repository";
    lines.push(`${mark} ${what}  ${d.code} ${d.message}`);
    lines.push(`    expected: ${valueText(d.expected)}`);
    lines.push(`    found:    ${valueText(d.actual)}`);
    const where = [d.specLocation, d.codeLocation].filter((l): l is Location => l !== undefined);
    if (where.length > 0) lines.push(`    where:    ${where.map(locationText).join("  ")}`);
    const fixes = (d.suggestions ?? []).map((s) => s.message);
    lines.push(`    fix:      ${fixes.length > 0 ? fixes.join("; ") : `see ${d.code}`}`);
  }
  for (const item of input.items) {
    if (item.passed) lines.push(`${style.green("✔")} ${item.item}`);
    else if (!item.enforceable) lines.push(`${style.dim("○")} ${item.item} (manual, not checked)`);
  }
  const enforceable = input.items.filter((i) => i.enforceable);
  const passed = enforceable.filter((i) => i.passed).length;
  const counts = countDiagnostics(shown);
  lines.push(`${passed} of ${plural(enforceable.length, "item")} pass; ${summary(counts)}`);
  lines.push(counts.errors === 0 ? style.green("DONE") : style.red("NOT DONE"));
  return `${lines.join("\n")}\n`;
}

const percent = (r: Ratio): string => `${r.percent}%`;

/** The `catspec coverage` report. */
export function formatCoverage(report: CoverageReport, style: Style = PLAIN): string {
  const { satisfaction, enforcement, reverse } = report;
  const lines = [
    `${style.bold("contract satisfaction")}  ${percent(satisfaction)}  (${satisfaction.count} of ${plural(satisfaction.total, "enforceable item")} pass)`,
    `${style.bold("enforcement coverage")}   ${percent(enforcement)}  (${enforcement.count} enforceable, ${enforcement.manual} manual, ${enforcement.unenforcedProse} unenforced prose)`,
    `${style.bold("reverse coverage")}       ${percent(reverse)}  (${reverse.count} of ${plural(reverse.total, "source file")} bound by a spec)`,
  ];
  if (report.specs.length > 0) {
    lines.push("");
    const rows = [
      ["SPEC", "STATUS", "SATISFIED", "ENFORCEABLE", "MANUAL", "PROSE"],
      ...report.specs.map((s) => [
        s.spec,
        s.status,
        `${s.satisfaction.count}/${s.satisfaction.total}`,
        String(s.enforceable),
        String(s.manual),
        String(s.unenforcedProse),
      ]),
    ];
    const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
    rows.forEach((row, i) => {
      const line = row
        .map((cell, c) => (c === row.length - 1 ? cell : cell.padEnd(widths[c]!)))
        .join("  ");
      lines.push(i === 0 ? style.bold(line) : line);
    });
  }
  return `${lines.join("\n")}\n`;
}
