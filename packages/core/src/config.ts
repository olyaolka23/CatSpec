/**
 * `catspec.yaml` (plan §D4): schema, defaults and discovery. Every key has a default, so a
 * repository without a config works. The `workflow` section is kept as written and validated by
 * the workflow profiles (plan §D17).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { LineCounter, parseDocument } from "yaml";
import * as z from "zod";

import { formatPath, locate, schemaIssues } from "./schema-issues.js";
import { listOf, relativePosix } from "./util.js";

export const CONFIG_FILE = "catspec.yaml";

const globList = z.array(z.string().min(1));

const language = (include: string[], exclude: string[]) =>
  z
    .strictObject({
      include: globList.default(include).describe("Source files of this language (globs)."),
      exclude: globList.default(exclude).describe("Files to leave out (globs)."),
    })
    .prefault({});

export const ConfigSchema = z
  .strictObject({
    version: z.literal(1).default(1).describe("Config format version."),
    layout: z
      .enum(["feature-folders", "free"])
      .default("feature-folders")
      .describe("feature-folders: specs live in docs/spec/<feature>/ (CS0106 otherwise)."),
    workflow: z
      .unknown()
      .optional()
      .describe("Workflow profile (plan §D17); validated by the workflow commands."),
    specs: z
      .strictObject({
        include: globList.default(["docs/spec/*/*.spec.md"]).describe("Machine spec files."),
        architecture: z
          .string()
          .min(1)
          .default("docs/architecture/adr/*-adr.md")
          .describe("The architecture spec (ADR log); exactly one file must match (CS0107)."),
      })
      .prefault({}),
    languages: z
      .strictObject({
        typescript: language(["src/**/*.{ts,tsx}"], ["**/*.d.ts", "**/node_modules/**"]),
        csharp: language(["src/**/*.cs"], ["**/obj/**", "**/bin/**", "**/*.g.cs"]),
      })
      .prefault({}),
    enforcement: z
      .strictObject({
        drift: z.enum(["off", "warn", "strict"]).default("warn"),
        unresolvable: z.enum(["warn", "error"]).default("warn"),
        unenforced_prose: z.enum(["off", "warn"]).default("warn"),
      })
      .prefault({}),
    heal: z
      .strictObject({
        mode: z.enum(["off", "suggest", "auto"]).default("suggest"),
        threshold: z.number().min(0).max(1).default(0.8),
      })
      .prefault({}),
    hook: z
      .strictObject({
        stage_generated: z
          .boolean()
          .default(true)
          .describe("Re-stage lock files and auto-healed specs."),
      })
      .prefault({}),
    refactor: z
      .strictObject({
        detect_threshold: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe("Broken bindings in one commit that count as a large refactor."),
        allow_wip: z.boolean().default(false),
      })
      .prefault({}),
    mcp: z
      .strictObject({
        allow_location_edits: z.boolean().default(true),
        allow_contract_edits: z.boolean().default(false),
      })
      .prefault({}),
  })
  .describe("CatSpec configuration (catspec.yaml).");

export type CatspecConfig = z.output<typeof ConfigSchema>;

/** The configuration used when the repository has no `catspec.yaml`. */
export const defaultConfig = (): CatspecConfig => ConfigSchema.parse({});

export interface ConfigIssue {
  /** The config file, relative to the repository root. */
  file: string;
  line: number;
  column: number;
  /** Dotted key path, e.g. `heal.mode`. */
  key: string;
  message: string;
  /** Allowed values, when the key has a fixed set. */
  allowed?: string[];
}

/** An invalid `catspec.yaml`; the CLI reports it as a usage/config error (exit code 2). */
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(issues.map((i) => `${i.file}:${i.line}:${i.column}: ${i.message}`).join("\n"));
    this.name = "ConfigError";
  }
}

/** Parses and validates the text of a `catspec.yaml`. Throws `ConfigError`. */
export function parseConfig(text: string, file = CONFIG_FILE): CatspecConfig {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const at = (offset: number): { line: number; column: number } => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };

  if (doc.errors.length > 0) {
    throw new ConfigError(
      doc.errors.map((error) => ({
        file,
        ...at(error.pos[0]),
        key: "",
        message: `invalid YAML: ${error.message.split("\n")[0]!.replace(/ at line \d+.*$/, "")}`,
      })),
    );
  }

  let value: unknown;
  try {
    value = (doc.toJS() as unknown) ?? {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError([
      { file, line: 1, column: 1, key: "", message: `the config can't be read: ${reason}` },
    ]);
  }
  const result = ConfigSchema.safeParse(value);
  if (result.success) return result.data;

  throw new ConfigError(
    schemaIssues(result.error.issues, doc, ConfigSchema).map((issue) => {
      const range = locate(doc, issue.path, issue.atKey);
      const allowed =
        Array.isArray(issue.expected) && issue.expected.every((v) => typeof v === "string")
          ? issue.expected
          : undefined;
      const hint =
        issue.suggestions.length > 0 ? `; did you mean ${listOf(issue.suggestions)}?` : "";
      return {
        file,
        ...(range ? at(range.start) : { line: 1, column: 1 }),
        key: formatPath(issue.path),
        message: issue.message + hint,
        ...(allowed ? { allowed } : {}),
      };
    }),
  );
}

export interface LoadedConfig {
  config: CatspecConfig;
  /**
   * Absolute path of the repository root: the folder of the `catspec.yaml` that was found, else
   * (no config, or `--config`) the git root, else `cwd`.
   */
  root: string;
  /** Absolute path of the config file, if one was found. */
  file?: string;
}

/** The closest folder at or above `dir` that contains `.git`, if any. */
export function findGitRoot(dir: string): string | undefined {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

/**
 * The git common directory of the repository at `root` (where `.git` is): `.git` itself, or for a
 * linked worktree the main repository's `.git`, so every worktree shares one cache. Read from
 * the files git writes, without running git. Undefined outside a git repository.
 */
export function findGitCommonDir(root: string): string | undefined {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return undefined;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!pointer) return undefined;
    gitDir = resolve(root, pointer[1]!);
  }
  const commonDir = join(gitDir, "commondir");
  return existsSync(commonDir) ? resolve(gitDir, readFileSync(commonDir, "utf8").trim()) : gitDir;
}

/**
 * Finds `catspec.yaml` by walking up from `cwd` to the git root (or the file-system root outside
 * a git repository).
 */
export function findConfig(cwd: string): string | undefined {
  const stop = findGitRoot(cwd);
  for (let current = resolve(cwd); ; current = dirname(current)) {
    const candidate = join(current, CONFIG_FILE);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    if (current === stop || dirname(current) === current) return undefined;
  }
}

/**
 * Loads the configuration for a command run in `cwd`. `configPath` (the `--config` flag) skips
 * discovery. Throws `ConfigError` for an invalid file, and when `configPath` doesn't exist.
 */
export async function loadConfig(cwd: string, configPath?: string): Promise<LoadedConfig> {
  const file = configPath ? resolve(cwd, configPath) : findConfig(cwd);
  if (!file) {
    return { config: defaultConfig(), root: findGitRoot(cwd) ?? resolve(cwd) };
  }
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) {
    throw new ConfigError([
      { file, line: 1, column: 1, key: "", message: `config file not found: ${file}` },
    ]);
  }
  // A config given with --config may live anywhere (e.g. ci/catspec.yaml); the specs are still
  // found from the repository root.
  const root = configPath ? (findGitRoot(cwd) ?? resolve(cwd)) : dirname(file);
  return { config: parseConfig(text, relativePosix(root, file)), root, file };
}

/** JSON Schema of `catspec.yaml`, for editor autocompletion. */
export const configJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(ConfigSchema, { io: "input", target: "draft-2020-12" });
