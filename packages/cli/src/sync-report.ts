/**
 * The `catspec sync` reports (plan §D11.4, §D11.8): JSON for tools and the MCP server, text with
 * the diff of every spec edit for people.
 */
import { formatDiff } from "./diff.js";
import { formatText, type Style } from "./report.js";
import type { AppliedSync, SyncRun } from "./sync.js";

export interface SyncOutcome {
  applied: AppliedSync | undefined;
  refused: boolean;
  ended: boolean;
}

const bindingsOf = (groups: { bindings: { spec: string; binding: string }[] }[]): number =>
  groups.reduce((n, g) => n + g.bindings.length, 0);

/** The `sync --format json` report. */
export function syncJson(run: SyncRun, outcome: SyncOutcome) {
  const { mapped, ambiguous, lost } = run.plan.report;
  const name = (resolved: string): string => resolved;
  const target = (e: { file: { path: string }; symbol: { qualifiedName: string } }): string =>
    `${e.file.path}#${e.symbol.qualifiedName}`;
  return {
    mapped: mapped.flatMap((m) =>
      m.bindings.map((b) => ({
        spec: b.spec,
        binding: b.binding,
        from: name(b.resolved),
        to: target(m.target),
        evidence: m.evidence,
        ...(m.score !== undefined ? { score: m.score } : {}),
        ...(m.detail ? { detail: m.detail } : {}),
      })),
    ),
    ambiguous: ambiguous.flatMap((a) =>
      a.bindings.map((b) => ({
        spec: b.spec,
        binding: b.binding,
        from: name(b.resolved),
        candidates: a.candidates.map((c) => ({ symbol: target(c.entry), score: c.score })),
      })),
    ),
    lost: lost.flatMap((l) =>
      l.bindings.map((b) => ({
        spec: b.spec,
        binding: b.binding,
        from: name(b.resolved),
        ...(l.best ? { best: { symbol: target(l.best.entry), score: l.best.score } } : {}),
      })),
    ),
    edits: run.plan.edits.map((e) => ({ file: e.spec.file, ops: e.ops })),
    diagnostics: run.plan.diagnostics,
    applied: outcome.applied !== undefined,
    refused: outcome.refused,
    written: outcome.applied?.written ?? [],
    staged: outcome.applied?.staged ?? [],
    refactor: run.refactor
      ? { active: !outcome.ended, ended: outcome.ended }
      : { active: false, ended: false },
  };
}

/** The `sync` text report: the diagnostics, the diff of every edit, and what happened. */
export function syncText(
  run: SyncRun,
  outcome: SyncOutcome & {
    apply: boolean;
    partial: boolean;
    style: Style;
    quiet: boolean;
    verbose: boolean;
  },
): string {
  const { style } = outcome;
  const { report, edits, diagnostics } = run.plan;
  const parts: string[] = [];
  if (diagnostics.length > 0) {
    parts.push(formatText(diagnostics, { style, quiet: outcome.quiet, verbose: outcome.verbose }));
  }
  if (!outcome.quiet)
    for (const edit of edits)
      parts.push(formatDiff(edit.spec.file, edit.spec.source.text, edit.text, style));
  const counts =
    `${bindingsOf(report.mapped)} mapped, ${bindingsOf(report.ambiguous)} ambiguous, ` +
    `${bindingsOf(report.lost)} lost` +
    (run.refactor ? ` (refactor from ${run.refactor.revision.slice(0, 12)})` : "");
  const lines: string[] = [];
  if (run.broken.length === 0 && edits.length === 0) {
    lines.push(
      run.refactor
        ? "every binding of the refactor resolves; nothing to sync"
        : "every binding resolves; nothing to sync",
    );
    if (outcome.apply && run.refactor && outcome.ended)
      lines.push(style.green("the refactor is finished"));
  } else if (!outcome.apply) {
    lines.push(
      `${counts}; dry run: no file was changed${edits.length > 0 ? "; run `catspec sync --apply` to write the edits" : ""}`,
    );
  } else if (outcome.refused) {
    lines.push(
      `${counts}; ${style.red("nothing written")}: name the ambiguous and lost bindings in a rename map (--map), restore the code or change the specs; --partial writes the mapped part` +
        (run.refactor ? " (the refactor stays open)" : ""),
    );
  } else {
    const applied = outcome.applied!;
    const unstaged = applied.written.filter((f) => !applied.staged.includes(f));
    lines.push(
      `${counts}; ${style.green("wrote")} ${applied.written.length > 0 ? applied.written.join(", ") : "nothing"}` +
        (applied.staged.length > 0
          ? `; staged ${applied.staged.length === applied.written.length ? "them" : applied.staged.join(", ")}`
          : "") +
        (unstaged.length > 0 ? `; not staged (unstaged changes): ${unstaged.join(", ")}` : ""),
    );
    if (run.refactor) {
      lines.push(
        outcome.ended
          ? `${style.green("the refactor is finished")}: commit the code, specs and lock files together`
          : "the refactor stays open: map the rest, then run `catspec sync --apply` again",
      );
    }
  }
  parts.push(`${lines.join("\n")}\n`);
  return parts.join("");
}
