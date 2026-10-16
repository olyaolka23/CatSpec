/**
 * `catspec install-hooks` / `uninstall-hooks` (plan §D13), PBI `hook-installer`: installs the
 * pre-commit hook next to the hook tool the repository already uses. A plain git hook goes in the
 * hooks folder (`core.hooksPath` included); with husky or lefthook an entry is added to their
 * config instead. A pre-commit hook that CatSpec didn't write is never overwritten: without
 * `--force` the install is refused, with it the hook is kept as `pre-commit.catspec-backup` and
 * run first, and `uninstall-hooks` puts it back byte for byte.
 */
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { editYaml, readYaml, SpecEditError, toPosix, type Git } from "@catspec/core";

export const HOOK_MANAGERS = ["auto", "git", "husky", "lefthook"] as const;
export type HookManager = (typeof HOOK_MANAGERS)[number];

/** The marker that identifies a hook, or a block of one, written by CatSpec. */
export const MANAGED = "catspec-managed";
const BACKUP = "pre-commit.catspec-backup";
const LEFTHOOK_FILES = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"];

/** The staged check, through the project's own install when there is one (plan §4, Risks). */
const COMMAND =
  "if [ -f node_modules/.bin/catspec ]; then node_modules/.bin/catspec check --staged; " +
  "else npx --no-install catspec check --staged; fi";

export interface HookResult {
  manager: Exclude<HookManager, "auto">;
  /** The file written or removed, relative to the repository's top level. */
  file: string;
  /** What happened, as a sentence. */
  message: string;
  /** What the user still has to do, if anything. */
  next?: string;
}

/** The install would overwrite a hook CatSpec didn't write. */
export class HookRefusedError extends Error {}

interface Target {
  manager: Exclude<HookManager, "auto">;
  topLevel: string;
  /** The hook file or config file. */
  path: string;
}

async function target(git: Git, manager: HookManager): Promise<Target> {
  const { topLevel } = await git.repository();
  const lefthook = LEFTHOOK_FILES.map((f) => join(topLevel, f)).find((f) => existsSync(f));
  const husky = join(topLevel, ".husky");
  const chosen =
    manager !== "auto"
      ? manager
      : lefthook
        ? "lefthook"
        : existsSync(husky) && statSync(husky).isDirectory()
          ? "husky"
          : "git";
  const path =
    chosen === "lefthook"
      ? (lefthook ?? join(topLevel, "lefthook.yml"))
      : chosen === "husky"
        ? join(husky, "pre-commit")
        : join(await git.gitPath("hooks"), "pre-commit");
  return { manager: chosen, topLevel, path };
}

const show = (t: Target, path = t.path): string => toPosix(relative(t.topLevel, path));

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

/** The plain git hook script; `chained` runs the backed-up hook first. */
function hookScript(chained: boolean): string {
  return [
    "#!/bin/sh",
    `# ${MANAGED}: the CatSpec pre-commit hook (catspec install-hooks; remove with catspec uninstall-hooks)`,
    ...(chained ? [`# The hook that was here before runs first; it is kept as ${BACKUP}.`] : []),
    ...(chained ? [`"$(dirname "$0")/${BACKUP}" "$@" || exit $?`] : []),
    COMMAND,
    "",
  ].join("\n");
}

const BLOCK = [`# >>> ${MANAGED}`, `${COMMAND} || exit $?`, `# <<< ${MANAGED}`].join("\n");
const BLOCK_PATTERN = new RegExp(`\\n?# >>> ${MANAGED}\\n[\\s\\S]*?# <<< ${MANAGED}\\n?`);

/** Installs the pre-commit hook. Throws `HookRefusedError` over a foreign hook without `force`. */
export async function installHooks(
  git: Git,
  options: { manager?: HookManager; force?: boolean } = {},
): Promise<HookResult> {
  const t = await target(git, options.manager ?? "auto");
  const file = show(t);
  const existing = await readText(t.path);

  if (t.manager === "lefthook") {
    const text = existing ?? "";
    const path = ["pre-commit", "commands", "catspec", "run"];
    if (lefthookValue(text, file, path) === COMMAND) {
      return { manager: t.manager, file, message: `${file} already runs CatSpec` };
    }
    await writeFile(
      t.path,
      lefthookEdit(text, file, [{ op: "set", path, value: COMMAND }]),
      "utf8",
    );
    return {
      manager: t.manager,
      file,
      message: `added the catspec command to pre-commit in ${file}`,
      next: "run `lefthook install` to apply it",
    };
  }

  if (t.manager === "husky") {
    if (existing?.includes(`# >>> ${MANAGED}`)) {
      return { manager: t.manager, file, message: `${file} already runs CatSpec` };
    }
    const text =
      existing === undefined || existing === ""
        ? `${BLOCK}\n`
        : `${existing}${existing.endsWith("\n") ? "" : "\n"}${BLOCK}\n`;
    await mkdir(dirname(t.path), { recursive: true });
    await writeFile(t.path, text, "utf8");
    return {
      manager: t.manager,
      file,
      message:
        existing === undefined
          ? `created ${file}`
          : `added CatSpec to ${file}; the existing commands still run first`,
    };
  }

  const backup = join(dirname(t.path), BACKUP);
  const ours = existing?.includes(MANAGED) === true;
  if (existing !== undefined && !ours) {
    if (!options.force) {
      throw new HookRefusedError(
        [
          `refused: ${file} exists and wasn't installed by CatSpec, so it is left unchanged.`,
          "To run CatSpec too, add this line to it:",
          "  npx --no-install catspec check --staged",
          `or run \`catspec install-hooks --force\` to keep it as ${BACKUP}, run it first and then CatSpec.`,
        ].join("\n"),
      );
    }
    if (existsSync(backup)) {
      throw new HookRefusedError(
        `refused: ${show(t, backup)} already exists; restore or remove it first, so no hook is lost`,
      );
    }
    await rename(t.path, backup);
  }
  const script = hookScript(existsSync(backup));
  if (existing === script) {
    return { manager: t.manager, file, message: `${file} is already installed` };
  }
  await mkdir(dirname(t.path), { recursive: true });
  await writeFile(t.path, script, "utf8");
  await chmod(t.path, 0o755);
  return {
    manager: t.manager,
    file,
    message:
      existing !== undefined && !ours
        ? `installed ${file}; the previous hook is kept as ${show(t, backup)} and runs first`
        : ours
          ? `updated ${file}`
          : `installed ${file}`,
  };
}

/** Removes the pre-commit hook, and restores the hook it replaced. */
export async function uninstallHooks(
  git: Git,
  options: { manager?: HookManager } = {},
): Promise<HookResult> {
  const t = await target(git, options.manager ?? "auto");
  const file = show(t);
  const existing = await readText(t.path);
  const absent = { manager: t.manager, file, message: `CatSpec isn't installed in ${file}` };

  if (t.manager === "lefthook") {
    const command = ["pre-commit", "commands", "catspec"];
    if (existing === undefined || lefthookValue(existing, file, command) === undefined) {
      return absent;
    }
    let text = lefthookEdit(existing, file, [{ op: "delete", path: command }]);
    for (const path of [command.slice(0, 2), command.slice(0, 1)]) {
      const value = lefthookValue(text, file, path);
      if (value !== null && typeof value === "object" && Object.keys(value).length === 0) {
        text = lefthookEdit(text, file, [{ op: "delete", path }]);
      }
    }
    await writeFile(t.path, text, "utf8");
    return {
      manager: t.manager,
      file,
      message: `removed the catspec command from ${file}`,
      next: "run `lefthook install` to apply it",
    };
  }

  if (t.manager === "husky") {
    if (existing === undefined || !BLOCK_PATTERN.test(existing)) return absent;
    const text = existing.replace(BLOCK_PATTERN, (block) =>
      block.startsWith("\n") && block.endsWith("\n") ? "\n" : "",
    );
    if (text.trim() === "") await rm(t.path);
    else await writeFile(t.path, text, "utf8");
    return { manager: t.manager, file, message: `removed CatSpec from ${file}` };
  }

  if (existing === undefined || !existing.includes(MANAGED)) return absent;
  const backup = join(dirname(t.path), BACKUP);
  await rm(t.path);
  if (existsSync(backup)) {
    await rename(backup, t.path);
    return {
      manager: t.manager,
      file,
      message: `removed CatSpec and restored the previous ${file}`,
    };
  }
  return { manager: t.manager, file, message: `removed ${file}` };
}

/** A value of the lefthook config; refuses a config that isn't valid YAML. */
function lefthookValue(text: string, file: string, path: string[]): unknown {
  try {
    return readYaml(text, path);
  } catch (error) {
    if (error instanceof SpecEditError) throw new HookRefusedError(`${file}: ${error.message}`);
    throw error;
  }
}

/** Edits the lefthook config, keeping its comments and layout. */
function lefthookEdit(text: string, file: string, ops: Parameters<typeof editYaml>[1]): string {
  try {
    return editYaml(text, ops);
  } catch (error) {
    if (error instanceof SpecEditError) throw new HookRefusedError(`${file}: ${error.message}`);
    throw error;
  }
}
