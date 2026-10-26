/**
 * `catspec init --agents` (plan §D14.3, §D17.5), PBI `agent-setup`: tells coding agents how to
 * work with CatSpec and stops Claude Code from ending its turn while the work fails its checks.
 *
 * - `AGENTS.md`: the CatSpec block between `<!-- catspec:begin -->` and `<!-- catspec:end -->` is
 *   added, or replaced when it is already there. Everything outside the markers stays byte for byte.
 *   Its stage commands follow the workflow profile.
 * - `.claude/settings.json`: a `Stop` hook running `catspec check --in-progress --format agent` is
 *   merged into the existing settings; other settings and hooks are kept.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { agentSteps, defaultConfig, workflowProfile, type WorkflowProfile } from "@catspec/core";

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const BLOCK_BEGIN = "<!-- catspec:begin -->";
export const BLOCK_END = "<!-- catspec:end -->";
/** Runs in the project folder whatever folder the agent's shell is in. */
export const STOP_HOOK_COMMAND =
  'npx catspec --cwd "$CLAUDE_PROJECT_DIR" check --in-progress --format agent';

/** The command that connects Claude Code to the MCP server. */
export const CLAUDE_MCP_COMMAND = "claude mcp add catspec -- npx catspec mcp";

/**
 * The CatSpec block of `AGENTS.md` (also printed by `catspec workflow snippet agents`). The stage
 * commands come from the workflow profile (plan §D14.3, §D17.5).
 */
export const agentsBlock = (
  eol = "\n",
  profile: WorkflowProfile = workflowProfile(defaultConfig()),
): string => {
  const steps = agentSteps(profile);
  const perFeature = [steps.begin, ...steps.end].some((c) => c.endsWith("<feature>"));
  const finish = steps.end.map((c) => `\`${c}\``);
  const finishText =
    finish.length === 0
      ? "you are done"
      : finish.length === 1
        ? `run ${finish[0]}`
        : `run ${finish.slice(0, -1).join(", ")}, then ${finish.at(-1)}`;
  return [
    BLOCK_BEGIN,
    "## CatSpec workflow (agents must follow)",
    "",
    `Specs live in ${profile.featureDirs.map((d) => `\`${d.replaceAll("{feature}", "<feature>")}/<spec-id>.spec.md\``).join(" or ")}; the architecture rules in`,
    "`docs/architecture/adr/`. For every work item (spec) `<id>` you work on" +
      (perFeature ? " (`<feature>` is its feature folder):" : ":"),
    "",
    `1. Before coding run \`${steps.begin}\`. If it fails, stop and report why.`,
    "2. After each change run `catspec check --spec <id>` and fix everything it reports, until it",
    "   says DONE.",
    `3. When all tasks in \`<id>.spec.md\` are ticked and the check says DONE, ${finishText}.`,
    "4. Never weaken a contract in a `*.spec.md` to make a check pass. Ask the developer instead.",
    "",
    "Run `catspec next <feature>` to see the current stage and which work items are ready. With",
    "the CatSpec MCP server connected, the tools `next_step`, `start_stage`, `check_compliance` and",
    "`finish_stage` do the same as these commands. How CatSpec works (commands, spec format, rules,",
    "diagnostics): `catspec guide`, or the MCP tool `read_guide`.",
    BLOCK_END,
  ].join(eol);
};

export interface AgentsSetupResult {
  /** Files written, with what happened to each. */
  changes: { file: string; action: "created" | "updated" | "unchanged" }[];
}

/** A file `init --agents` can't merge into safely; nothing is written. */
export class AgentsSetupError extends Error {}

/** Writes the `AGENTS.md` block and the Claude Code `Stop` hook into the repository at `root`. */
export async function setupAgents(
  root: string,
  profile?: WorkflowProfile,
): Promise<AgentsSetupResult> {
  // Both files are computed before either is written, so a refusal leaves both untouched.
  const agents = await planAgentsFile(root, profile);
  const settings = await planClaudeSettings(root);
  const changes: AgentsSetupResult["changes"] = [];
  for (const plan of [agents, settings]) {
    if (plan.after === plan.before) {
      changes.push({ file: plan.file, action: "unchanged" });
      continue;
    }
    const path = join(root, plan.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, plan.after, "utf8");
    changes.push({ file: plan.file, action: plan.before === undefined ? "created" : "updated" });
  }
  return { changes };
}

interface FilePlan {
  file: string;
  before: string | undefined;
  after: string;
}

async function readText(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}

async function planAgentsFile(root: string, profile?: WorkflowProfile): Promise<FilePlan> {
  const before = await readText(join(root, AGENTS_FILE));
  return { file: AGENTS_FILE, before, after: withAgentsBlock(before, profile) };
}

/** `AGENTS.md` with the CatSpec block added or replaced; the rest of the text is kept as is. */
export function withAgentsBlock(text: string | undefined, profile?: WorkflowProfile): string {
  if (text === undefined || text === "") return `${agentsBlock("\n", profile)}\n`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = agentsBlock(eol, profile);
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (begin === -1 && end === -1) {
    const ending = text.endsWith(eol) ? "" : eol;
    return `${text}${ending}${eol}${block}${eol}`;
  }
  if (begin === -1 || end === -1 || end < begin) {
    throw new AgentsSetupError(
      `${AGENTS_FILE} has only one of the markers ${BLOCK_BEGIN} and ${BLOCK_END}; fix them by hand`,
    );
  }
  if (text.indexOf(BLOCK_BEGIN, begin + 1) !== -1 || text.indexOf(BLOCK_END, end + 1) !== -1) {
    throw new AgentsSetupError(
      `${AGENTS_FILE} has more than one CatSpec block; keep one between ${BLOCK_BEGIN} and ${BLOCK_END}`,
    );
  }
  return text.slice(0, begin) + block + text.slice(end + BLOCK_END.length);
}

async function planClaudeSettings(root: string): Promise<FilePlan> {
  const before = await readText(join(root, CLAUDE_SETTINGS_FILE));
  return { file: CLAUDE_SETTINGS_FILE, before, after: withStopHook(before) };
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

/** A CatSpec Stop hook, with or without `--cwd` (older `init --agents` wrote none). */
const isCatspecStopHook = (command: string | undefined): boolean =>
  command !== undefined && /\bcatspec\b.*\bcheck --in-progress\b/.test(command);

/** Claude Code settings with the CatSpec `Stop` hook added; other settings and hooks are kept. */
export function withStopHook(text: string | undefined): string {
  let settings: Record<string, unknown> = {};
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AgentsSetupError(
        `${CLAUDE_SETTINGS_FILE} isn't valid JSON (${(error as Error).message}); fix it, then run again`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AgentsSetupError(`${CLAUDE_SETTINGS_FILE} must hold a JSON object`);
    }
    settings = parsed as Record<string, unknown>;
  }
  const hooks = settings.hooks ?? {};
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new AgentsSetupError(`"hooks" in ${CLAUDE_SETTINGS_FILE} must be an object`);
  }
  const stop = (hooks as Record<string, unknown>).Stop ?? [];
  if (!Array.isArray(stop)) {
    throw new AgentsSetupError(`"hooks.Stop" in ${CLAUDE_SETTINGS_FILE} must be a list`);
  }
  const entries: HookEntry[] = stop.map((entry: unknown, i) => {
    const shape = `"hooks.Stop[${i}]" in ${CLAUDE_SETTINGS_FILE}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AgentsSetupError(`${shape} must be an object`);
    }
    const list = (entry as { hooks?: unknown }).hooks;
    if (list === undefined) return {};
    if (!Array.isArray(list)) throw new AgentsSetupError(`${shape}.hooks must be a list`);
    list.forEach((hook: unknown, j) => {
      if (hook === null || typeof hook !== "object" || Array.isArray(hook)) {
        throw new AgentsSetupError(`${shape}.hooks[${j}] must be an object`);
      }
      const command = (hook as { command?: unknown }).command;
      if (command !== undefined && typeof command !== "string") {
        throw new AgentsSetupError(`${shape}.hooks[${j}].command must be a string`);
      }
    });
    return entry;
  });
  const installed = entries.some((entry) =>
    entry.hooks?.some((hook) => isCatspecStopHook(hook.command)),
  );
  if (installed && text !== undefined) return text;
  const next = {
    ...settings,
    hooks: {
      ...(hooks as Record<string, unknown>),
      Stop: [...(stop as unknown[]), { hooks: [{ type: "command", command: STOP_HOOK_COMMAND }] }],
    },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** `AGENTS.md` without the CatSpec block; undefined when nothing else is left in it. */
export function withoutAgentsBlock(text: string): string | undefined {
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let before = text.slice(0, begin);
  let after = text.slice(end + BLOCK_END.length);
  // `init --agents` puts the block after a blank line and ends it with a line break.
  if (after.startsWith(eol)) after = after.slice(eol.length);
  if (after === "" && before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
  const rest = before + after;
  return rest.trim() === "" ? undefined : rest;
}

/**
 * Claude Code settings without the CatSpec `Stop` hook; hook lists and keys left empty are removed,
 * and undefined means nothing is left. Text that isn't a settings object comes back unchanged.
 */
export function withoutStopHook(text: string): string | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return text;
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return text;
  const object = settings as Record<string, unknown>;
  const hooks = object.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object" || !Array.isArray(hooks.Stop)) return text;
  // Entries that held only CatSpec hooks go; other entries keep their other hooks.
  const before = hooks.Stop as HookEntry[];
  const stop = before.flatMap((entry) => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const kept = entry.hooks.filter((h) => !isCatspecStopHook(h?.command));
    if (kept.length === entry.hooks.length) return [entry];
    return kept.length === 0 ? [] : [{ ...entry, hooks: kept }];
  });
  if (stop.length === before.length && stop.every((entry, i) => entry === before[i])) return text;
  const nextHooks: Record<string, unknown> = { ...hooks, Stop: stop };
  if (stop.length === 0) delete nextHooks.Stop;
  const next: Record<string, unknown> = { ...object, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0) delete next.hooks;
  return Object.keys(next).length === 0 ? undefined : `${JSON.stringify(next, null, 2)}\n`;
}
