/**
 * Feature F8 `workflow-profiles`, PBI `workflow-config`: the `workflow:` section of `catspec.yaml`
 * (plan §D17.2), its presets (plan §D17.3) and CS0700.
 */
import { describe, expect, it } from "vitest";

import {
  ConfigError,
  configJsonSchema,
  featureFolderOf,
  parseConfig,
  workflowProfile,
  type ConfigIssue,
} from "../src/index.js";

const issuesOf = (text: string): ConfigIssue[] => {
  try {
    parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected a ConfigError");
};

const stage = (lines: string): string =>
  `workflow:\n  preset: custom\n  stages:\n    - id: close\n      per: spec\n${lines}`;

describe("F8 workflow-profiles: PBI workflow-config", () => {
  it('[AC-workflow-config-1] an unknown gate name is CS0700 naming "contracts_passed" and suggesting "contracts_pass"', () => {
    const [issue, ...rest] = issuesOf(stage("      finish: { gates: [contracts_passed] }\n"));
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      code: "CS0700",
      key: "workflow.stages[0].finish.gates[0]",
      line: 6,
    });
    expect(issue!.message).toContain('"contracts_passed"');
    expect(issue!.message).toContain("did you mean contracts_pass?");
  });

  it("[AC-workflow-config-2] an unknown placeholder is CS0700 naming it and listing the valid ones", () => {
    const [issue] = issuesOf(stage('      produces: ["{featur_dir}/plan.md"]\n'));
    expect(issue).toMatchObject({ code: "CS0700", key: "workflow.stages[0].produces[0]" });
    expect(issue!.message).toContain('unknown placeholder "{featur_dir}"');
    expect(issue!.message).toContain("valid: {feature}, {feature_dir}, {spec}");
    expect(new ConfigError([issue!]).message).toContain("CS0700 ");
  });

  it("reports a feature_dir without exactly one {feature}, or with {spec}, as CS0700", () => {
    for (const dir of ["docs/features", "a/{feature}/{feature}", "docs/{feature}/{spec}"]) {
      expect(issuesOf(`workflow:\n  feature_dir: "${dir}"\n`)[0]).toMatchObject({
        code: "CS0700",
        key: "workflow.feature_dir",
        message: expect.stringContaining("exactly once") as string,
      });
    }
  });

  it("takes a list of feature folder patterns for features at several depths (domain folders)", () => {
    const config = parseConfig(
      'workflow:\n  preset: custom\n  feature_dir: ["docs/spec/{feature}", "docs/spec/billing/{feature}"]\n',
    );
    // Most specific first; spec discovery follows every pattern.
    expect(workflowProfile(config).featureDirs).toEqual([
      "docs/spec/billing/{feature}",
      "docs/spec/{feature}",
    ]);
    expect(workflowProfile(config).featureDir).toBe("docs/spec/{feature}");
    expect(config.specs.include).toEqual([
      "docs/spec/billing/*/*.spec.md",
      "docs/spec/*/*.spec.md",
    ]);

    // Each pattern is checked on its own.
    const [issue] = issuesOf('workflow:\n  feature_dir: ["docs/spec/{feature}", "docs/billing"]\n');
    expect(issue).toMatchObject({
      code: "CS0700",
      key: expect.stringContaining("workflow.feature_dir") as string,
      message: expect.stringContaining("exactly once") as string,
    });
  });

  it("finds a path's feature folder by the most specific pattern; domain folders aren't features", () => {
    const dirs = ["docs/spec/billing/{feature}", "docs/spec/{feature}"];
    expect(featureFolderOf(dirs, "docs/spec/billing/invoices/spec.md")).toEqual({
      name: "invoices",
      dir: "docs/spec/billing/invoices",
    });
    expect(featureFolderOf(dirs, "docs/spec/login/login.spec.md")).toEqual({
      name: "login",
      dir: "docs/spec/login",
    });
    expect(featureFolderOf(dirs, "docs/spec/billing/README.md")).toBeUndefined();
    expect(featureFolderOf(dirs, "docs/other/x.md")).toBeUndefined();
  });

  it("reports an unknown preset, an unknown stage key and a duplicate stage id as CS0700", () => {
    expect(issuesOf("workflow:\n  preset: opensepc\n")[0]).toMatchObject({
      code: "CS0700",
      message: expect.stringContaining("did you mean openspec?") as string,
    });
    expect(issuesOf(stage("      finsh: {}\n"))[0]!.message).toContain('unknown key "finsh"');
    const duplicate = issuesOf(
      "workflow:\n  preset: custom\n  stages:\n    - id: a\n    - id: a\n",
    )[0]!;
    expect(duplicate).toMatchObject({ code: "CS0700", key: "workflow.stages[1].id" });
  });

  it("presets fill in the stages, and a preset outside docs/spec/ changes the specs.include and layout defaults", () => {
    const catspec = workflowProfile(parseConfig(""));
    expect(catspec.stages.map((s) => s.id)).toEqual(["spec", "plan", "task", "close"]);

    const openspec = parseConfig("workflow:\n  preset: openspec\n");
    expect(workflowProfile(openspec).stages.map((s) => s.id)).toEqual([
      "proposal",
      "apply",
      "archive",
    ]);
    expect(openspec.specs.include).toEqual(["openspec/changes/**/*.spec.md"]);
    expect(openspec.layout).toBe("free");

    const specKit = parseConfig("workflow:\n  preset: spec-kit\n");
    expect(workflowProfile(specKit).stages.map((s) => s.driver)).toEqual(
      ["specify", "plan", "tasks", "implement"].map((c) => ({
        kind: "slash",
        name: `/speckit.${c}`,
      })),
    );
    expect(specKit.specs.include).toEqual(["specs/*/*.spec.md"]);

    // Values written in the file win.
    const written = parseConfig(
      'layout: feature-folders\nworkflow:\n  preset: openspec\nspecs:\n  include: ["x/*.spec.md"]\n',
    );
    expect(written.layout).toBe("feature-folders");
    expect(written.specs.include).toEqual(["x/*.spec.md"]);

    const custom = parseConfig(
      'workflow:\n  preset: custom\n  feature_dir: "features/{feature}"\n',
    );
    expect(custom.specs.include).toEqual(["features/*/*.spec.md"]);
  });

  it("the JSON Schema of catspec.yaml describes the workflow section", () => {
    const schema = configJsonSchema() as {
      properties: { workflow: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(schema.properties.workflow.properties)).toEqual(
      expect.arrayContaining(["preset", "allow_commands", "enforce_in_hook", "stages"]),
    );
  });
});
