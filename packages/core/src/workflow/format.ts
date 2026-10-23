/**
 * Plain-text answers of the workflow commands (plan §D17.5), shared by the CLI and the MCP server
 * so both say the same thing: `catspec next` / `next_step` and `catspec stage` / `start_stage`,
 * `finish_stage`.
 */
import { listOf } from "../util.js";
import type { ItemPosition, NextStep, StageInfo, StageRun } from "./engine.js";

const gatesText = (gates: string[]): string => (gates.length > 0 ? listOf(gates) : "none");

/** The stage's driver, gates and status changes, one per line. */
export function stageLines(stage: StageInfo): string[] {
  return [
    `  driver: ${stage.driverText}`,
    `  start gates: ${gatesText(stage.start.gates)}${stage.start.status ? ` → ${stage.start.status}` : ""}`,
    `  finish gates: ${gatesText(stage.finish.gates)}${stage.finish.status ? ` → ${stage.finish.status}` : ""}`,
  ];
}

const itemLine = (item: ItemPosition): string => {
  switch (item.state) {
    case "ready":
      return `  ready: ${item.spec} → stage ${item.stage}`;
    case "in-progress":
      return `  in progress: ${item.spec} → stage ${item.stage}`;
    case "waiting":
      return `  waiting: ${item.spec} (on ${listOf(item.waitingOn)})`;
    case "done":
      return `  done: ${item.spec}`;
  }
};

/** `catspec next`: the current stage, how to run it, and each work item. */
export function formatNextStep(next: NextStep, driverFor?: (stage: string) => string): string {
  const lines: string[] = [];
  if (next.done || !next.stage) {
    lines.push(`${next.target}: every stage is done`);
  } else {
    const stage = next.stage;
    lines.push(`${next.target}: stage ${stage.id} (per ${stage.per}), use ${stage.driverText}`);
    lines.push(...stageLines(stage).slice(1));
    if (next.inputs && next.inputs.length > 0) lines.push(`  read: ${listOf(next.inputs)}`);
    if (next.produces && next.produces.length > 0) {
      lines.push(`  produce: ${listOf(next.produces)}`);
    }
    if (stage.per === "feature") {
      lines.push(
        `  run \`catspec stage start ${stage.id} ${next.target}\` first and ` +
          `\`catspec stage finish ${stage.id} ${next.target}\` at the end`,
      );
    }
  }
  if (next.items.length > 0) {
    lines.push("work items:");
    for (const item of next.items) {
      const driver = item.stage && driverFor ? `, use ${driverFor(item.stage)}` : "";
      lines.push(
        itemLine(item) + (item.state === "ready" || item.state === "in-progress" ? driver : ""),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** `catspec stage start|finish`: the stage's context and each gate's result. */
export function formatStageRun(run: StageRun): string {
  const lines = [
    `stage ${run.stage.id} ${run.phase} for ${run.target}` +
      (run.specs.length > 0 ? ` (${listOf(run.specs)})` : ""),
    `  driver: ${run.stage.driverText}`,
  ];
  if (run.produces.length > 0) lines.push(`  produce: ${listOf(run.produces)}`);
  for (const gate of run.gates) {
    const mark = gate.skipped ? "-" : gate.passed ? "✔" : "✖";
    lines.push(`  ${mark} ${gate.gate}: ${gate.detail.split("\n").join("\n      ")}`);
  }
  if (run.gates.length === 0) lines.push(`  no ${run.phase} gates`);
  for (const change of run.changes) lines.push(`  ${change.spec}: ${change.from} → ${change.to}`);
  if (run.phase === "start" && run.ok) {
    const finish = run.stage.finish.gates;
    lines.push(
      `  when done run \`catspec stage finish ${run.stage.id} ${run.target}\`` +
        (finish.length > 0 ? ` (gates: ${listOf(finish)})` : ""),
    );
  }
  lines.push(
    run.ok
      ? run.forced
        ? `${run.phase === "start" ? "started" : "finished"} with --force (the override is logged)`
        : run.phase === "start"
          ? "started"
          : "finished"
      : `refused: the stage can't ${run.phase}`,
  );
  return `${lines.join("\n")}\n`;
}
