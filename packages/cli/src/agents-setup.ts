/**
 * `catspec init --agents` (plan §D14.3, §D17.5), PBI `agent-setup`: tells coding agents how to
 * work with CatSpec and stops Claude Code from ending its turn while the work fails its checks.
 *
 * - `AGENTS.md`: the CatSpec block between `<!-- catspec:begin -->` and `<!-- catspec:end -->` is
 *   added, or replaced when it is already there. Everything outside the markers stays byte for byte.
 * - `.claude/settings.json`: a `Stop` hook running `catspec check --in-progress --format agent` is
 *   merged into the existing settings; other settings and hooks are kept.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const BLOCK_BEGIN = "<!-- catspec:begin -->";
export const BLOCK_END = "<!-- catspec:end -->";
export const STOP_HOOK_COMMAND = "npx catspec check --in-progress --format agent";

/** The command that connects Claude Code to the MCP server. */
export const CLAUDE_MCP_COMMAND = "claude mcp add catspec -- npx catspec mcp";

/** The CatSpec block of `AGENTS.md` (also printed by `catspec init --agents`). */
export const agentsBlock = (eol = "\n"): string =>
  [
    BLOCK_BEGIN,
    "## CatSpec workflow (agents must follow)",
    "",
    "Specs live in `docs/spec/<feature>/<spec-id>.spec.md`; the architecture rules in",
    "`docs/architecture/adr/`. For every work item (spec) `<id>` you work on:",
    "",
    "1. Before coding run `catspec status <id> in-progress`. If it is refused, stop and report why.",
    "2. After each change run `catspec check --spec <id>` and fix everything it reports, until it",
    "   says DONE.",
    "3. When all tasks in `<id>.spec.md` are done and the check says DONE, run",
    "   `catspec status <id> implemented`.",
    "4. Never weaken a contract in a `*.spec.md` to make a check pass. Ask the developer instead.",
    "",
    "With the CatSpec MCP server connected, the tools `get_spec_context`, `check_compliance` and",
    "`set_spec_status` do the same as these commands.",
    BLOCK_END,
  ].join(eol);

export interface AgentsSetupResult {
  /** Files written, with what happened to each. */
  changes: { file: string; action: "created" | "updated" | "unchanged" }[];
}

/** A file `init --agents` can't merge into safely; nothing is written. */
export class AgentsSetupError extends Error {}

/** Writes the `AGENTS.md` block and the Claude Code `Stop` hook into the repository at `root`. */
export async function setupAgents(root: string): Promise<AgentsSetupResult> {
  // Both files are computed before either is written, so a refusal leaves both untouched.
  const agents = await planAgentsFile(root);
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

async function planAgentsFile(root: string): Promise<FilePlan> {
  const before = await readText(join(root, AGENTS_FILE));
  return { file: AGENTS_FILE, before, after: withAgentsBlock(before) };
}

/** `AGENTS.md` with the CatSpec block added or replaced; the rest of the text is kept as is. */
export function withAgentsBlock(text: string | undefined): string {
  if (text === undefined || text === "") return `${agentsBlock()}\n`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = agentsBlock(eol);
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
  const installed = (stop as HookEntry[]).some((entry) =>
    entry?.hooks?.some((hook) => hook?.command?.includes("catspec check --in-progress")),
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
