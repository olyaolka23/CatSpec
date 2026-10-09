import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkAcceptance,
  parseClosedFeatures,
  parseFeatureFile,
  parseVitestResults,
  type TaggedTest,
} from "./check-acceptance.js";

const fence = "```";

/** Builds a feature file in the same shape as `docs/spec/<epic>/features/*.md`. */
function featureFile(options: { dod?: boolean[]; pbiBoxes?: boolean[] } = {}): string {
  const box = (ticked: boolean, text: string): string => `- [${ticked ? "x" : " "}] ${text}`;
  const dod = options.dod ?? [false, false];
  const pbiBoxes = options.pbiBoxes ?? [false, false];
  return [
    "# F9 · `demo`",
    "",
    "> Acceptance: `@AC-F9-1..1`.",
    "",
    "## Acceptance criteria",
    "",
    `${fence}gherkin`,
    "Feature: F9 demo",
    "",
    "  @AC-F9-1",
    "  Scenario: The demo works end to end",
    "    Given a demo",
    "    Then it works",
    fence,
    "",
    "## Definition of Done (feature)",
    ...dod.map((ticked, i) => box(ticked, `feature item ${i + 1}`)),
    "",
    "## PBI `demo-pbi`",
    "Does the demo.",
    "- depends on: —",
    ...pbiBoxes.map((ticked, i) => box(ticked, `task ${i + 1}`)),
    "",
    `${fence}gherkin`,
    "  @AC-demo-pbi-1",
    "  Scenario: First behaviour",
    "    Given something",
    "    Then something else",
    "",
    "  @AC-demo-pbi-2",
    "  Scenario: Second behaviour",
    "    Given something",
    "    Then something else",
    fence,
    "",
  ].join("\n");
}

const test = (tag: string, status = "passed"): TaggedTest => ({
  tag,
  title: `[${tag}] does it`,
  file: "x.test.ts",
  status,
});

describe("parseFeatureFile", () => {
  it("reads feature and PBI scenarios, ignoring tag ranges outside Gherkin blocks", () => {
    const feature = parseFeatureFile(featureFile(), "docs/spec/epic/features/demo.md");
    expect(feature.id).toBe("demo");
    expect(feature.closed).toBe(false);
    expect(feature.scenarios).toEqual([{ tag: "AC-F9-1", name: "The demo works end to end" }]);
    expect(feature.pbis).toEqual([
      {
        id: "demo-pbi",
        ticked: false,
        scenarios: [
          { tag: "AC-demo-pbi-1", name: "First behaviour" },
          { tag: "AC-demo-pbi-2", name: "Second behaviour" },
        ],
      },
    ]);
  });

  it("treats a PBI as ticked only when every box is ticked", () => {
    const partly = parseFeatureFile(featureFile({ pbiBoxes: [true, false] }), "demo.md");
    const fully = parseFeatureFile(featureFile({ pbiBoxes: [true, true] }), "demo.md");
    expect(partly.pbis[0]?.ticked).toBe(false);
    expect(fully.pbis[0]?.ticked).toBe(true);
  });

  it("treats a feature as closed when its Definition of Done is ticked or the plan ticks it", () => {
    expect(parseFeatureFile(featureFile({ dod: [true, true] }), "demo.md").closed).toBe(true);
    expect(parseFeatureFile(featureFile(), "demo.md", true).closed).toBe(true);
  });
});

describe("parseClosedFeatures", () => {
  it("returns the features ticked in plan Progress", () => {
    const plan = [
      "## 1. Progress",
      "- [x] F0 [`repo-scaffolding`](./features/repo-scaffolding.md)",
      "- [ ] F1 [`spec-model`](./features/spec-model.md)",
    ].join("\n");
    expect([...parseClosedFeatures(plan)]).toEqual(["repo-scaffolding"]);
  });
});

describe("parseVitestResults", () => {
  it("keeps only tests whose name starts with an acceptance tag", () => {
    const tests = parseVitestResults({
      testResults: [
        {
          name: "/repo/a.test.ts",
          assertionResults: [
            { title: "[AC-demo-pbi-1] works", status: "passed" },
            { title: "helper works", status: "passed" },
            { title: "mentions [AC-demo-pbi-2] later", status: "failed" },
          ],
        },
      ],
    });
    expect(tests).toEqual([
      {
        tag: "AC-demo-pbi-1",
        title: "[AC-demo-pbi-1] works",
        file: "/repo/a.test.ts",
        status: "passed",
      },
    ]);
  });
});

describe("checkAcceptance", () => {
  const ticked = parseFeatureFile(featureFile({ pbiBoxes: [true, true] }), "demo.md");

  it("passes a ticked PBI whose scenarios all have passing tests", () => {
    const result = checkAcceptance([ticked], [test("AC-demo-pbi-1"), test("AC-demo-pbi-2")]);
    expect(result.errors).toEqual([]);
    expect(result.checkedScenarios).toBe(2);
  });

  it("[AC-ci-pipeline-2] fails a ticked PBI with a failing tagged test, naming the PBI and scenario", () => {
    const result = checkAcceptance(
      [ticked],
      [test("AC-demo-pbi-1", "failed"), test("AC-demo-pbi-2")],
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("PBI demo-pbi");
    expect(result.errors[0]).toContain('AC-demo-pbi-1 "First behaviour"');
    expect(result.errors[0]).toContain("did not pass");
  });

  it("fails a ticked PBI whose scenario has no test, or only a skipped one", () => {
    const missing = checkAcceptance([ticked], [test("AC-demo-pbi-1")]);
    expect(missing.errors).toEqual([
      'PBI demo-pbi (demo.md) is ticked: scenario AC-demo-pbi-2 "Second behaviour" has no test',
    ]);
    const skipped = checkAcceptance(
      [ticked],
      [test("AC-demo-pbi-1"), test("AC-demo-pbi-2", "skipped")],
    );
    expect(skipped.errors).toHaveLength(1);
    expect(skipped.errors[0]).toContain("(skipped)");
  });

  it("[AC-ci-pipeline-3] passes an unticked PBI that has no tests yet", () => {
    const unticked = parseFeatureFile(featureFile({ pbiBoxes: [true, false] }), "demo.md");
    const result = checkAcceptance([unticked], []);
    expect(result.errors).toEqual([]);
    expect(result.checkedScenarios).toBe(0);
  });

  it("[AC-ci-pipeline-4] fails on a test tag that is not in any feature file", () => {
    const result = checkAcceptance(
      [ticked],
      [test("AC-demo-pbi-1"), test("AC-demo-pbi-2"), test("AC-unknown-1")],
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^unknown acceptance tag AC-unknown-1\b/);
  });

  it("requires the feature scenarios and every PBI scenario of a closed feature", () => {
    const closed = parseFeatureFile(featureFile({ dod: [true, true] }), "demo.md");
    const result = checkAcceptance([closed], [test("AC-demo-pbi-1"), test("AC-demo-pbi-2")]);
    expect(result.errors).toEqual([
      'feature demo (demo.md) is closed: scenario AC-F9-1 "The demo works end to end" has no test',
    ]);
  });

  it("fails on a tag used twice in the feature files", () => {
    const a = parseFeatureFile(featureFile(), "a.md");
    const b = parseFeatureFile(featureFile(), "b.md");
    const result = checkAcceptance([a, b], []);
    expect(result.errors).toContain("duplicate acceptance tag AC-F9-1 in a.md and b.md");
  });
});

describe("acceptance-coverage CLI", () => {
  const script = resolve(fileURLToPath(import.meta.url), "..", "check-acceptance.ts");
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function runCli(feature: string, results: object) {
    dir = await mkdtemp(join(tmpdir(), "catspec-acceptance-"));
    const featuresDir = join(dir, "docs", "spec", "demo-epic", "features");
    await mkdir(featuresDir, { recursive: true });
    await writeFile(join(featuresDir, "demo.md"), feature);
    await writeFile(join(dir, "results.json"), JSON.stringify(results));
    return spawnSync(
      process.execPath,
      ["--import", "tsx", script, "--root", dir, "--results", "results.json"],
      { encoding: "utf8" },
    );
  }

  it("[AC-F0-2] rejects a ticked PBI whose scenario has no test, naming the missing tag", async () => {
    const results = {
      testResults: [
        {
          name: "demo.test.ts",
          assertionResults: [{ title: "[AC-demo-pbi-1] first", status: "passed" }],
        },
      ],
    };
    const run = await runCli(featureFile({ pbiBoxes: [true, true] }), results);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("PBI demo-pbi");
    expect(run.stderr).toContain("AC-demo-pbi-2");
    expect(run.stderr).toContain("has no test");
  });

  it("succeeds when nothing is ticked", async () => {
    const run = await runCli(featureFile(), { testResults: [] });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("acceptance-coverage: OK");
  });
});
