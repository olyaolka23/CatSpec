import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkAcceptance,
  parseClosedFeatures,
  parseFeatureFile,
  parseVitestResults,
  unclaimedSpecScenarios,
  type TaggedTest,
} from "./acceptance-coverage.js";

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

describe("tagging rules", () => {
  /** A feature file with one ticked PBI whose Gherkin block is `body`, fenced with `lang`. */
  const pbiFile = (body: string[], lang = "gherkin"): string =>
    ["## PBI `p`", "- [x] task", "", `${fence}${lang}`, ...body, fence, ""].join("\n");

  it("has no problems for a well-formed feature file", () => {
    expect(parseFeatureFile(featureFile(), "demo.md").problems).toEqual([]);
  });

  it("accepts every Gherkin scenario keyword and the cucumber and feature fences", () => {
    for (const keyword of ["Scenario", "Scenario Outline", "Scenario Template", "Example"]) {
      const feature = parseFeatureFile(pbiFile(["@AC-p-1", `${keyword}: works`]), "f.md");
      expect(feature.pbis[0]?.scenarios, keyword).toEqual([{ tag: "AC-p-1", name: "works" }]);
    }
    for (const lang of ["cucumber", "feature"]) {
      const feature = parseFeatureFile(pbiFile(["@AC-p-1", "Scenario: works"], lang), "f.md");
      expect(feature.pbis[0]?.scenarios, lang).toEqual([{ tag: "AC-p-1", name: "works" }]);
    }
  });

  it("reports a scenario without an @AC tag, or with two", () => {
    const untagged = parseFeatureFile(pbiFile(["Scenario: no tag"]), "f.md");
    expect(untagged.problems).toEqual(['f.md:5: scenario "no tag" has no @AC tag']);
    const twice = parseFeatureFile(pbiFile(["@AC-p-1 @AC-p-2", "Scenario: two"]), "f.md");
    expect(twice.problems).toEqual([
      'f.md:6: scenario "two" has more than one @AC tag: AC-p-1, AC-p-2',
    ]);
  });

  it("reports an @AC tag that isn't on a scenario", () => {
    const onExamples = parseFeatureFile(
      pbiFile(["@AC-p-1", "Scenario Outline: o", "  Given <x>", "@AC-p-2", "Examples:", "| x |"]),
      "f.md",
    );
    expect(onExamples.problems).toEqual([
      'f.md:8: AC-p-2 is on a "Examples:" line, not on a scenario',
    ]);
    expect(onExamples.pbis[0]?.scenarios).toEqual([{ tag: "AC-p-1", name: "o" }]);

    const dangling = parseFeatureFile(pbiFile(["@AC-p-1"]), "f.md");
    expect(dangling.problems).toEqual(["f.md:5: AC-p-1 is not followed by a scenario"]);
  });

  it("reports an @AC tag outside a Gherkin block, and a scenario outside the PBIs", () => {
    const unlabelled = parseFeatureFile(pbiFile(["@AC-p-1", "Scenario: s"], "text"), "f.md");
    expect(unlabelled.problems).toEqual([
      "f.md:5: acceptance tag outside a ```gherkin block: @AC-p-1",
    ]);

    const orphan = parseFeatureFile(
      ["## Description", `${fence}gherkin`, "@AC-x-1", "Scenario: s", fence].join("\n"),
      "f.md",
    );
    expect(orphan.problems).toEqual([
      'f.md:4: scenario AC-x-1 is not under "Acceptance criteria" or a PBI',
    ]);
  });

  it("fails the check on any tagging problem, ticked or not", () => {
    const feature = parseFeatureFile(pbiFile(["Scenario: no tag"]).replace("[x]", "[ ]"), "f.md");
    expect(checkAcceptance([feature], []).errors).toEqual([
      'f.md:5: scenario "no tag" has no @AC tag',
    ]);
  });
});

describe("unclaimedSpecScenarios", () => {
  it("claims every MVP scenario of this repository's epic (spec §5 against plan §2)", () => {
    const epic = join(resolve(fileURLToPath(import.meta.url), "..", ".."), "docs", "spec");
    const dir = join(epic, "reactive-ast-linked-spec-engine");
    expect(
      unclaimedSpecScenarios(
        readFileSync(join(dir, "spec.md"), "utf8"),
        readFileSync(join(dir, "plan.md"), "utf8"),
      ),
    ).toEqual([]);
  });

  it("skips Post-MVP items and reads lists of spec AC in the plan's feature table", () => {
    const spec =
      "## 5. Acceptance\n\n1. **A**\n2. *(Post-MVP, ADR-014.)* **B**\n3. **C**\n4. **D**\n";
    expect(unclaimedSpecScenarios(spec, "| F1 | x | (spec AC-1, AC-3) |\n")).toEqual([4]);
    expect(unclaimedSpecScenarios(spec, "spec AC-4 outside the table\n")).toEqual([1, 3, 4]);
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

  it("fails a ticked PBI or a closed feature that has no scenarios", () => {
    const empty = parseFeatureFile(
      ["## Definition of Done (feature)", "- [x] done", "", "## PBI `p`", "- [x] task"].join("\n"),
      "empty.md",
    );
    expect(checkAcceptance([empty], []).errors).toEqual([
      "feature empty (empty.md) is closed: it has no acceptance scenarios",
      "PBI p (empty.md) is ticked: it has no acceptance scenarios",
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

  async function runCli(
    feature: string,
    results: object,
    scriptPath = script,
    options: { args?: string[]; epicFiles?: Record<string, string> } = {},
  ) {
    dir = await mkdtemp(join(tmpdir(), "catspec-acceptance-"));
    const featuresDir = join(dir, "docs", "spec", "demo-epic", "features");
    await mkdir(featuresDir, { recursive: true });
    await writeFile(join(featuresDir, "demo.md"), feature);
    for (const [name, text] of Object.entries(options.epicFiles ?? {})) {
      await writeFile(join(dir, "docs", "spec", "demo-epic", name), text);
    }
    await writeFile(join(dir, "results.json"), JSON.stringify(results));
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--root",
        dir,
        "--results",
        "results.json",
        ...(options.args ?? []),
      ],
      { encoding: "utf8" },
    );
  }

  const passing = (...tags: string[]) => ({
    testResults: [
      {
        name: "demo.test.ts",
        assertionResults: tags.map((tag) => ({ title: `[${tag}] works`, status: "passed" })),
      },
    ],
  });
  const SPEC =
    "# Spec\n\n## 5. Acceptance scenarios (MVP)\n\n1. **One**: a.\n2. *(Post-MVP.)* **Two**: b.\n" +
    "3. **Three**: c.\n\n## 6. Later\n\n4. not a scenario\n";
  const PLAN = (acceptance: string) =>
    `# Plan\n\n| # | Feature | Acceptance |\n|---|---|---|\n| F9 | demo | ${acceptance} |\n`;

  it("[AC-F9-3] the release sweep (--all) requires a passing test for every scenario of every feature, ticked or not, and a feature for every MVP spec scenario", async () => {
    const feature = featureFile();
    const epicFiles = { "spec.md": SPEC, "plan.md": PLAN("`@AC-F9-1` (spec AC-1, AC-3)") };

    const missing = await runCli(feature, passing("AC-F9-1", "AC-demo-pbi-1"), script, {
      args: ["--all"],
      epicFiles,
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('scenario AC-demo-pbi-2 "Second behaviour" has no test');

    const unclaimed = await runCli(
      feature,
      passing("AC-F9-1", "AC-demo-pbi-1", "AC-demo-pbi-2"),
      script,
      { args: ["--all"], epicFiles: { ...epicFiles, "plan.md": PLAN("(spec AC-1)") } },
    );
    expect(unclaimed.status).toBe(1);
    expect(unclaimed.stderr).toContain("MVP acceptance scenario 3 is not claimed");

    const green = await runCli(
      feature,
      passing("AC-F9-1", "AC-demo-pbi-1", "AC-demo-pbi-2"),
      script,
      { args: ["--all"], epicFiles },
    );
    expect(green.stderr).toBe("");
    expect(green.status).toBe(0);
    expect(green.stdout).toContain("release sweep: every scenario");
  });

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

  it("runs the check when started through a symlinked path", async () => {
    const link = await mkdtemp(join(tmpdir(), "catspec-link-"));
    try {
      // A junction needs no extra rights on Windows; on other systems the type is ignored.
      await symlink(dirname(script), join(link, "scripts"), "junction");
      const linked = join(link, "scripts", "check-acceptance.ts");
      const run = await runCli(
        featureFile({ pbiBoxes: [true, true] }),
        { testResults: [] },
        linked,
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("AC-demo-pbi-1");
    } finally {
      // Remove the link itself first so the recursive delete never follows it into scripts/.
      await unlink(join(link, "scripts")).catch(() => undefined);
      await rm(link, { recursive: true, force: true });
    }
  });
});
