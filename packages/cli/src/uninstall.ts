/**
 * `catspec uninstall`: takes CatSpec out of a repository. It removes what `init --hooks --agents`
 * wired in: the pre-commit hook, the Claude Code `Stop` hook and the `AGENTS.md` block. With
 * `--files` it also deletes `catspec.yaml`, the local cache, and the example feature and the ADR
 * log while they are still as `init` wrote them. Specs, lock files and anything edited are kept.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  CONFIG_FILE,
  findGitCommonDir,
  globMatcher,
  listFiles,
  loadConfig,
  type Git,
} from "@catspec/core";

import {
  AGENTS_FILE,
  CLAUDE_SETTINGS_FILE,
  withoutAgentsBlock,
  withoutStopHook,
} from "./agents-setup.js";
import { uninstallHooks } from "./hooks.js";
import { adrTemplate, exampleFeatureFiles } from "./init.js";

export interface UninstallStep {
  action: "removed" | "updated" | "kept";
  /** A file or folder, relative to the repository root, or what was done. */
  what: string;
  /** Why a file was kept. */
  reason?: string;
}

export interface UninstallResult {
  steps: UninstallStep[];
  /** What the user still has to do. */
  next: string[];
}

const readText = async (path: string): Promise<string | undefined> =>
  existsSync(path) ? (await readFile(path, "utf8")).replace(/\r\n/g, "\n") : undefined;

/** Removes CatSpec from the repository at `root`; `git` is undefined outside a git repository. */
export async function uninstall(
  root: string,
  git: Git | undefined,
  options: { files?: boolean } = {},
): Promise<UninstallResult> {
  const steps: UninstallStep[] = [];

  if (git) {
    const hook = await uninstallHooks(git);
    if (!hook.message.startsWith("CatSpec isn't installed")) {
      steps.push({ action: "removed", what: hook.message });
    }
  }

  for (const [file, without] of [
    [CLAUDE_SETTINGS_FILE, withoutStopHook],
    [AGENTS_FILE, withoutAgentsBlock],
  ] as const) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    const rest = without(text);
    if (rest === text) continue;
    if (rest === undefined) {
      await rm(path);
      steps.push({ action: "removed", what: file });
    } else {
      await writeFile(path, rest, "utf8");
      steps.push({
        action: "updated",
        what: `${file} (${file === AGENTS_FILE ? "CatSpec block" : "Stop hook"} removed)`,
      });
    }
  }

  if (options.files) {
    // Read the config before deleting it: it says where the ADR log is.
    const { config } = await loadConfig(root);
    const files = await listFiles(root);

    for (const [file, template] of Object.entries(exampleFeatureFiles())) {
      const text = await readText(join(root, file));
      if (text === undefined) continue;
      if (text === template) {
        await rm(join(root, file));
        steps.push({ action: "removed", what: file });
      } else {
        steps.push({ action: "kept", what: file, reason: "edited since init" });
      }
    }
    const exampleDir = join(root, dirname(Object.keys(exampleFeatureFiles())[0]!));
    if (existsSync(exampleDir) && readdirSync(exampleDir).length === 0) await rmdir(exampleDir);

    const isArchitecture = globMatcher(config.specs.architecture);
    for (const file of files.filter((f) => isArchitecture(f))) {
      const text = (await readText(join(root, file)))!;
      const name = basename(file).replace(/-adr\.md$/, "");
      const date = /\*\*Date:\*\* (\S+)/.exec(text)?.[1] ?? "";
      if (text === adrTemplate(name, date)) {
        await rm(join(root, file));
        steps.push({ action: "removed", what: file });
      } else {
        steps.push({ action: "kept", what: file, reason: "it has your decisions or rules" });
      }
    }

    if (existsSync(join(root, CONFIG_FILE))) {
      await rm(join(root, CONFIG_FILE));
      steps.push({ action: "removed", what: CONFIG_FILE });
    }

    const commonDir = findGitCommonDir(root);
    const local = commonDir === undefined ? undefined : join(commonDir, "catspec");
    if (local !== undefined && existsSync(local)) {
      await rm(local, { recursive: true, force: true });
      steps.push({ action: "removed", what: "the local cache and logs (in the git folder)" });
    }

    const specs = files.filter(
      (f) => /\.(spec\.md|lock\.json)$/.test(f) && existsSync(join(root, f)),
    );
    if (specs.length > 0) {
      steps.push({
        action: "kept",
        what: `${specs.length} spec and lock file(s)`,
        reason: "your specs; delete them yourself if you no longer want them",
      });
    }
  }

  const next = ["if you connected the MCP server: claude mcp remove catspec"];
  const manifest = await readText(join(root, "package.json"));
  if (manifest !== undefined && /"(catspec|@catspec\/[a-z-]+)"\s*:/.test(manifest)) {
    next.unshift("remove the package: npm uninstall catspec (and any @catspec/* packages)");
  }
  if (!options.files) {
    next.push("run catspec uninstall --files to also delete catspec.yaml and init's example files");
  }
  return { steps, next };
}
