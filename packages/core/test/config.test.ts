import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRepo, type TempRepo } from "../../../test/temp-repo.js";
import {
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

/** The defaults of plan §D4 (the `workflow` section is validated by the workflow profiles). */
const PLAN_D4_DEFAULTS = {
  version: 1,
  layout: "feature-folders",
  specs: {
    include: ["docs/spec/*/*.spec.md"],
    architecture: "docs/architecture/adr/*-adr.md",
  },
  languages: {
    typescript: { include: ["src/**/*.{ts,tsx}"], exclude: ["**/*.d.ts", "**/node_modules/**"] },
    csharp: { include: ["src/**/*.cs"], exclude: ["**/obj/**", "**/bin/**", "**/*.g.cs"] },
  },
  enforcement: { drift: "warn", unresolvable: "warn", unenforced_prose: "warn" },
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

  it("uses --config instead of discovery, and reports a missing file", async () => {
    const { dir } = await repo({ "config/custom.yaml": "layout: free\n" });
    const loaded = await loadConfig(dir, "config/custom.yaml");
    expect(loaded.config.layout).toBe("free");
    expect(loaded.root).toBe(join(dir, "config"));
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

  it("keeps the workflow section as written for the workflow profiles", () => {
    const config = parseConfig("workflow:\n  preset: custom\n  stages: []\n");
    expect(config.workflow).toEqual({ preset: "custom", stages: [] });
    expect(ConfigSchema.shape.workflow).toBeDefined();
  });
});
