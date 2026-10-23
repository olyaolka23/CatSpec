import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRepo, type TempRepo } from "../../../test/temp-repo.js";
import {
  findGitCommonDir,
  ConfigError,
  ConfigSchema,
  defaultConfig,
  loadConfig,
  parseConfig,
  type ConfigIssue,
} from "../src/index.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});
const repo = async (files: Record<string, string>, git = true): Promise<TempRepo> => {
  const created = await createRepo(files, { git });
  repos.push(created);
  return created;
};

const issuesOf = (text: string): ConfigIssue[] => {
  try {
    parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected a ConfigError");
};

/** The defaults of plan §D4 (the `workflow` section: plan §D17). */
const PLAN_D4_DEFAULTS = {
  version: 1,
  layout: "feature-folders",
  workflow: { preset: "catspec", allow_commands: false, enforce_in_hook: "warn" },
  specs: {
    include: ["docs/spec/*/*.spec.md"],
    architecture: "docs/architecture/adr/*-adr.md",
  },
  languages: {
    typescript: { include: ["src/**/*.{ts,tsx}"], exclude: ["**/*.d.ts", "**/node_modules/**"] },
    csharp: { include: ["src/**/*.cs"], exclude: ["**/obj/**", "**/bin/**", "**/*.g.cs"] },
  },
  enforcement: { drift: "warn", unresolvable: "warn", unenforced_prose: "warn" },
  // `tests.command` (no default) is named by PBI `query-and-test-rules` (F3).
  tests: {},
  heal: { mode: "suggest", threshold: 0.8 },
  hook: { stage_generated: true },
  refactor: { detect_threshold: 10, allow_wip: false },
  mcp: { allow_location_edits: true, allow_contract_edits: false },
};

describe("config-loader", () => {
  it("[AC-config-loader-1] uses the defaults of plan §D4 when there is no catspec.yaml", async () => {
    const { dir } = await repo({ "src/a.ts": "" });
    const loaded = await loadConfig(dir);
    expect(loaded.file).toBeUndefined();
    expect(loaded.root).toBe(dir);
    expect(loaded.config).toEqual(PLAN_D4_DEFAULTS);
    expect(defaultConfig()).toEqual(PLAN_D4_DEFAULTS);
    // An empty file, or a partial one, gets the same defaults for every key it doesn't set.
    expect(parseConfig("")).toEqual(PLAN_D4_DEFAULTS);
    expect(parseConfig("heal:\n  mode: auto\n")).toEqual({
      ...PLAN_D4_DEFAULTS,
      heal: { mode: "auto", threshold: 0.8 },
    });
  });

  it("[AC-config-loader-2] reports an invalid value with its key, line and allowed values", () => {
    const text = [
      "version: 1",
      "layout: feature-folders",
      "specs:",
      '  include: ["docs/spec/*/*.spec.md"]',
      "enforcement:",
      "  drift: warn",
      "  unresolvable: warn",
      "  unenforced_prose: warn",
      "hook:",
      "  stage_generated: true",
      "heal:",
      "  mode: sometimes",
      "  threshold: 0.8",
      "",
    ].join("\n");
    const issues = issuesOf(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      key: "heal.mode",
      line: 12,
      allowed: ["off", "suggest", "auto"],
    });
    expect(issues[0]!.message).toContain("heal.mode");
    expect(issues[0]!.message).toContain("off, suggest, auto");
    expect(new ConfigError(issues).message).toMatch(/^catspec\.yaml:12:9: heal\.mode/);
  });

  it("[AC-config-loader-3] finds the root catspec.yaml from a subfolder", async () => {
    const { dir } = await repo({ "catspec.yaml": "layout: free\n", "src/services/a.ts": "" });
    const loaded = await loadConfig(join(dir, "src", "services"));
    expect(loaded.file).toBe(join(dir, "catspec.yaml"));
    expect(loaded.root).toBe(dir);
    expect(loaded.config.layout).toBe("free");
  });

  it("stops looking at the git root", async () => {
    const outer = await repo({ "catspec.yaml": "layout: free\n" }, false);
    const inner = join(outer.dir, "inner");
    await mkdir(join(inner, ".git"), { recursive: true });
    await mkdir(join(inner, "src"), { recursive: true });
    const loaded = await loadConfig(join(inner, "src"));
    expect(loaded.file).toBeUndefined();
    expect(loaded.root).toBe(inner);
    expect(loaded.config.layout).toBe("feature-folders");
  });

  it("uses --config instead of discovery, keeps the repository root, and reports a missing file", async () => {
    const { dir } = await repo({ "ci/catspec.yaml": "layout: free\nheal:\n  mode: never\n" });
    await expect(loadConfig(dir, "ci/catspec.yaml")).rejects.toThrow(
      /^ci\/catspec\.yaml:3:9: heal\.mode/,
    );
    const { dir: other } = await repo({ "ci/catspec.yaml": "layout: free\n" });
    const loaded = await loadConfig(other, "ci/catspec.yaml");
    expect(loaded.config.layout).toBe("free");
    expect(loaded.root).toBe(other);
    expect(loaded.file).toBe(join(other, "ci", "catspec.yaml"));
    await expect(loadConfig(dir, "nope.yaml")).rejects.toThrow(/config file not found/);
  });

  it("reports unknown keys with a suggestion, wrong types and invalid YAML", () => {
    const [unknown] = issuesOf("enforcment:\n  drift: warn\n");
    expect(unknown).toMatchObject({ key: "enforcment", line: 1, column: 1 });
    expect(unknown!.message).toContain("did you mean enforcement");

    const [type] = issuesOf("heal:\n  threshold: high\n");
    expect(type).toMatchObject({ key: "heal.threshold", line: 2 });
    expect(type!.message).toContain("expected a number");

    const [range] = issuesOf("heal:\n  threshold: 2\n");
    expect(range!.message).toContain("at most 1");

    const [yaml] = issuesOf("heal: [\n");
    expect(yaml!.message).toContain("invalid YAML");
  });

  it("validates the workflow section with the config: its problems are CS0700", () => {
    const config = parseConfig("workflow:\n  preset: custom\n");
    expect(config.workflow).toMatchObject({ preset: "custom", allow_commands: false });
    expect(ConfigSchema.shape.workflow).toBeDefined();
    const [issue] = issuesOf("workflow:\n  preset: custom\n  stages: []\n");
    expect(issue).toMatchObject({ code: "CS0700", key: "workflow.stages", line: 3 });
  });

  it("reports a config with too many aliases as a config error", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "",
    ].join("\n");
    expect(issuesOf(bomb)[0]!.message).toContain("can't be read");
  });
});

describe("findGitCommonDir", () => {
  it("is .git in a repository, the main .git for a linked worktree, and undefined outside git", async () => {
    const base = await mkdtemp(join(tmpdir(), "catspec-gitdir-"));
    try {
      await mkdir(join(base, "main", ".git", "worktrees", "wt"), { recursive: true });
      await writeFile(join(base, "main", ".git", "worktrees", "wt", "commondir"), "../..\n");
      await mkdir(join(base, "wt"));
      await writeFile(
        join(base, "wt", ".git"),
        `gitdir: ${join(base, "main", ".git", "worktrees", "wt")}\n`,
      );
      await mkdir(join(base, "plain"));

      expect(findGitCommonDir(join(base, "main"))).toBe(join(base, "main", ".git"));
      expect(findGitCommonDir(join(base, "wt"))).toBe(join(base, "main", ".git"));
      expect(findGitCommonDir(join(base, "plain"))).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
