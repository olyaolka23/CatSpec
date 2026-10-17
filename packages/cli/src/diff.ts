/**
 * A small line diff for showing spec edits (`catspec sync`, the hook's CS0210 patch): changed
 * lines with one line of context, in the unified-diff style people already read.
 */
import type { Style } from "./report.js";

/** The diff of one file: `--- a/file`, `+++ b/file`, then hunks; empty when nothing changed. */
export function formatDiff(file: string, before: string, after: string, style: Style): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence table, from the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { kind: " " | "-" | "+"; text: string; line: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]!, line: i + 1 });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ kind: "-", text: a[i]!, line: i + 1 });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j]!, line: i + 1 });
      j++;
    }
  }
  const lines = [style.dim(`--- a/${file}`), style.dim(`+++ b/${file}`)];
  const changed = ops.map((op, k) => (op.kind !== " " ? k : -1)).filter((k) => k >= 0);
  const shown = new Set<number>();
  for (const k of changed)
    for (let c = k - 1; c <= k + 1; c++) if (c >= 0 && c < ops.length) shown.add(c);
  let last = -2;
  for (const k of [...shown].sort((x, y) => x - y)) {
    if (k !== last + 1) lines.push(style.cyan(`@@ line ${ops[k]!.line} @@`));
    const op = ops[k]!;
    const text = `${op.kind}${op.text.replace(/\r$/, "")}`;
    lines.push(op.kind === "-" ? style.red(text) : op.kind === "+" ? style.green(text) : text);
    last = k;
  }
  return `${lines.join("\n")}\n`;
}
