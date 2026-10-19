/**
 * `catspec check --in-progress --format agent` (plan §D10, §D14.3), PBI `agent-check-mode`: the
 * check an agent's stop hook runs. It checks the specs that are `in-progress` in the working tree
 * (the work items being done on this branch) as if they were implemented, and answers with the
 * Claude Code hook convention: exit 0 when done, 2 with a fix list on stderr when not, 1 on errors.
 *
 * Loop protection: an agent that can't fix something would be blocked forever. The hook input
 * (JSON on stdin) names the agent's session; when the same diagnostics have blocked it
 * `--max-blocks` times in a row, the next stop is let through and the user is told the work item
 * is stuck. The counter lives in the runtime store, `<git-common-dir>/catspec/agent-stop.json`
 * (ADR-004), and any change in the diagnostics resets it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findGitCommonDir,
  sortDiagnostics,
  type Diagnostic,
  type ItemResult,
  type Spec,
  type SpecModel,
} from "@catspec/core";

import { formatAgentReport, PLAIN } from "./report.js";

/** Default of `--max-blocks`. */
export const DEFAULT_MAX_BLOCKS = 3;

/** Agent-format exit codes (Claude Code hooks): done, error shown to the user, agent blocked. */
export const AGENT_EXIT = { done: 0, error: 1, blocked: 2 } as const;

/** The specs the agent is working on: `in-progress` in the working tree. */
export const inProgressSpecs = (model: SpecModel): Spec[] =>
  model.specs.all().filter((s) => s.status === "in-progress" && s.type !== "architecture");

/** What the hook tells Claude Code (on stdin); only the session is used. */
export interface HookInput {
  session_id?: string;
}

/** Parses the hook input; anything that isn't a JSON object counts as none. */
export function parseHookInput(text: string | undefined): HookInput | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Same errors, same fingerprint: what loop protection compares between two stops. */
export function diagnosticsFingerprint(diagnostics: readonly Diagnostic[]): string {
  const errors = sortDiagnostics(diagnostics.filter((d) => d.severity === "error")).map((d) =>
    [d.code, d.spec ?? "", d.item ?? "", d.message].join("\0"),
  );
  return createHash("sha256").update(errors.join("\n")).digest("hex");
}

interface StopEntry {
  fingerprint: string;
  /** Stops blocked in a row with this fingerprint. */
  blocks: number;
  updatedAt: string;
}

type StopStore = Record<string, StopEntry>;

/** Entries older than this are dropped, so the store doesn't grow with every session. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** The runtime-store file of the loop counter; outside git a folder in the temp dir per root. */
export function stopStoreFile(root: string): string {
  const common = findGitCommonDir(root);
  if (common !== undefined) return join(common, "catspec", "agent-stop.json");
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(tmpdir(), `catspec-${key}`, "agent-stop.json");
}

async function readStore(file: string): Promise<StopStore> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as StopStore)
      : {};
  } catch {
    return {};
  }
}

async function writeStore(file: string, store: StopStore): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export interface StopDecision {
  /** True: block the agent (exit 2). False: let it stop. */
  block: boolean;
  /** Blocks in a row with these diagnostics, this one included. */
  blocks: number;
  /** True when the agent is let go although the work isn't done. */
  stuck: boolean;
}

/**
 * Records a stop the check failed and decides whether to block it: the first `maxBlocks` stops
 * with the same diagnostics are blocked, the next is let through as stuck and the count restarts.
 */
export async function recordFailedStop(
  root: string,
  session: string,
  fingerprint: string,
  maxBlocks: number,
  now = new Date(),
): Promise<StopDecision> {
  const file = stopStoreFile(root);
  const store = pruned(await readStore(file), now);
  const previous = store[session];
  const blocks = previous?.fingerprint === fingerprint ? previous.blocks + 1 : 1;
  const stuck = blocks > maxBlocks;
  if (stuck) delete store[session];
  else store[session] = { fingerprint, blocks, updatedAt: now.toISOString() };
  await writeStore(file, store);
  return { block: !stuck, blocks, stuck };
}

/** Forgets a session's failed stops (its work is done). */
export async function clearStops(root: string, session: string, now = new Date()): Promise<void> {
  const file = stopStoreFile(root);
  const store = await readStore(file);
  if (!(session in store)) return;
  delete store[session];
  await writeStore(file, pruned(store, now));
}

function pruned(store: StopStore, now: Date): StopStore {
  const result: StopStore = {};
  for (const [session, entry] of Object.entries(store)) {
    const at = Date.parse(entry.updatedAt);
    if (Number.isFinite(at) && now.getTime() - at < STALE_MS) result[session] = entry;
  }
  return result;
}

/** The fix list sent back to a blocked agent. */
export function agentFixList(input: {
  specs: readonly Spec[];
  items: readonly ItemResult[];
  diagnostics: readonly Diagnostic[];
}): string {
  const ids = input.specs.map((s) => s.id).join(", ");
  return (
    `CatSpec: the work in progress (${ids}) is NOT DONE. Fix everything below before you stop, ` +
    "then run `catspec check --spec <id>` until it says DONE.\n" +
    "Never weaken a contract in a *.spec.md to make a check pass; ask the developer instead.\n\n" +
    formatAgentReport(input, PLAIN)
  );
}

/** What the user is told when a stuck agent is let go. */
export const stuckMessage = (specs: readonly Spec[], blocks: number): string =>
  `CatSpec: ${specs.map((s) => s.id).join(", ")} is stuck: the agent was blocked ${blocks - 1} ` +
  "times in a row with the same failing checks and is now allowed to stop. The work stays " +
  "in-progress; run `catspec check --in-progress` to see what fails.";
