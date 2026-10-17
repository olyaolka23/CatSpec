/**
 * `catspec check --staged` (plan §D11.3, §D13, ADR-009), PBI `staged-check`: checks the commit
 * being made. Specs, lock files and code are read from the git index, never from the working
 * tree, so a partially staged file is checked as it will be committed. Only the specs the commit
 * touches are checked, on the changed files and their own files; when a result depends on the
 * whole repository (a binding that has moved, a type alias), the check is repeated on every file
 * of the index.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  checkCode,
  Git,
  IndexProvider,
  loadSpecModel,
  parseConfig,
  relativePosix,
  stagedDiagnostics,
  stagedScope,
  type CatspecConfig,
  type CheckResult,
  type Codebase,
  type Diagnostic,
  type SpecModel,
  type StagedScope,
} from "@catspec/core";

import { loadAdapters, loadCodebase } from "./codebase.js";

export interface StagedCheck {
  model: SpecModel;
  scope: StagedScope;
  result: CheckResult;
  /** The code the check ran on. */
  codebase: Codebase;
  diagnostics: Diagnostic[];
  /** Source files whose facts the check read, sorted. */
  files: string[];
  git: Git;
}

/** A command that needs a git repository was run outside one. */
export class NotARepositoryError extends Error {}

/**
 * Runs the staged check for the repository at `root`. `configFile` is the absolute path of the
 * `catspec.yaml` in use: its staged version is used when it is in the index.
 */
export async function checkStaged(
  root: string,
  config: CatspecConfig,
  options: { env?: NodeJS.ProcessEnv; configFile?: string } = {},
): Promise<StagedCheck> {
  const git = new Git(root, options.env);
  if (!(await git.isRepository())) {
    throw new NotARepositoryError("--staged needs a git repository");
  }
  const index = new IndexProvider(git);
  try {
    if (options.configFile !== undefined) {
      const path = relativePosix(root, options.configFile);
      const staged = await index.read(path);
      if (staged !== undefined) config = parseConfig(staged.toString("utf8"), path);
    }
    const [model, changes, listing, registry] = await Promise.all([
      loadSpecModel(root, config, index),
      git.stagedChanges(),
      index.list(),
      loadAdapters(config),
    ]);
    const changed = new Set(changes.flatMap((c) => [c.path, ...(c.from ? [c.from] : [])]));
    const changedFacts = (
      await loadCodebase(root, config, { source: index, registry, only: (p) => changed.has(p) })
    ).files;
    const scope = stagedScope(
      model,
      changes,
      changedFacts,
      listing.map((e) => e.path),
    );
    const files = scope.files;
    let codebase = await loadCodebase(root, config, {
      source: index,
      registry,
      ...(files ? { only: (p: string) => files.has(p) } : {}),
    });
    let result = await checkCode(model, codebase, { specs: scope.specs, mode: "status" });
    if (result.repositoryWide && files) {
      codebase = await loadCodebase(root, config, { source: index, registry });
      result = await checkCode(model, codebase, { specs: scope.specs, mode: "status" });
    }
    return {
      model,
      scope,
      result,
      codebase,
      diagnostics: stagedDiagnostics(model, scope, result.diagnostics, changedFacts),
      files: codebase.files.map((f) => f.path),
      git,
    };
  } catch (error) {
    await git.close();
    throw error;
  }
}

/** The marker of a commit made with `CATSPEC_SKIP=1`, reported by the next staged check. */
const skipMarker = async (git: Git): Promise<string> =>
  join((await git.repository()).commonDir, "catspec", "skipped");

/** Records that the staged check was skipped. */
export async function recordSkip(git: Git): Promise<void> {
  const marker = await skipMarker(git);
  await mkdir(join(marker, ".."), { recursive: true });
  await writeFile(marker, `${new Date().toISOString()}\n`, "utf8");
}

/** When the previous staged check was skipped: when, and forgets it. */
export async function takeSkip(git: Git): Promise<string | undefined> {
  const marker = await skipMarker(git);
  const when = await readFile(marker, "utf8").catch(() => undefined);
  if (when !== undefined) await rm(marker, { force: true });
  return when?.trim();
}
