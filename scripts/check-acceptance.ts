/**
 * Acceptance-coverage check (plan §3 "How the Definition of Done is enforced", PBI `ci-pipeline`).
 *
 * Reads the Gherkin scenario tags (`@AC-…`) from every `docs/spec/<epic>/features/*.md`, finds the
 * PBIs whose boxes are all ticked and the features that are closed, and matches each scenario to
 * the tests whose name starts with its tag in brackets (`[AC-…]`), using the Vitest JSON results.
 *
 * Fails when:
 * - a ticked PBI or a closed feature has a scenario with no test, or with a test that didn't pass;
 * - a test is tagged with a tag that isn't in any feature file;
 * - the same tag appears twice in the feature files.
 *
 * Usage: tsx scripts/check-acceptance.ts [--root <dir>] [--results <vitest-json>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Scenario {
  tag: string;
  name: string;
}

export interface Pbi {
  id: string;
  /** True when the PBI has at least one checkbox and every checkbox is ticked. */
  ticked: boolean;
  scenarios: Scenario[];
}

export interface Feature {
  id: string;
  file: string;
  /** True when every box of its Definition of Done is ticked, or it is ticked in plan §1 Progress. */
  closed: boolean;
  scenarios: Scenario[];
  pbis: Pbi[];
}

export interface TaggedTest {
  tag: string;
  title: string;
  file: string;
  status: string;
}

export interface CheckResult {
  errors: string[];
  checkedScenarios: number;
}

const TAG_TOKEN = /@(AC-[A-Za-z0-9][A-Za-z0-9-]*)/g;
const TEST_TAG = /^\[(AC-[A-Za-z0-9][A-Za-z0-9-]*)\]/;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]/;
const PBI_HEADING = /^##\s+PBI\s+`([^`]+)`/;
const FENCE = /^\s*(```|~~~)\s*(\S*)/;

type Section =
  { kind: "feature" } | { kind: "dod" } | { kind: "pbi"; pbi: Pbi } | { kind: "other" };

interface Boxes {
  total: number;
  ticked: number;
}

const allTicked = (boxes: Boxes): boolean => boxes.total > 0 && boxes.ticked === boxes.total;

/** Parses one feature file. `closedInPlan` marks a feature ticked in plan §1 Progress. */
export function parseFeatureFile(text: string, file: string, closedInPlan = false): Feature {
  const id = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
  const feature: Feature = { id, file, closed: false, scenarios: [], pbis: [] };
  const dod: Boxes = { total: 0, ticked: 0 };
  const pbiBoxes = new Map<Pbi, Boxes>();

  let section: Section = { kind: "other" };
  let fence: { gherkin: boolean } | undefined;
  let pendingTags: string[] = [];

  const addScenario = (scenario: Scenario): void => {
    if (section.kind === "feature") feature.scenarios.push(scenario);
    else if (section.kind === "pbi") section.pbi.scenarios.push(scenario);
  };

  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      fence = fence ? undefined : { gherkin: fenceMatch[2]?.toLowerCase() === "gherkin" };
      pendingTags = [];
      continue;
    }

    if (fence) {
      if (!fence.gherkin) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("@")) {
        pendingTags.push(...[...trimmed.matchAll(TAG_TOKEN)].map((m) => m[1]!));
      } else if (/^Scenario( Outline)?:/.test(trimmed)) {
        const name = trimmed.replace(/^Scenario( Outline)?:\s*/, "");
        for (const tag of pendingTags) addScenario({ tag, name });
        pendingTags = [];
      }
      continue;
    }

    if (line.startsWith("## ")) {
      const pbiMatch = PBI_HEADING.exec(line);
      if (pbiMatch) {
        const pbi: Pbi = { id: pbiMatch[1]!, ticked: false, scenarios: [] };
        feature.pbis.push(pbi);
        pbiBoxes.set(pbi, { total: 0, ticked: 0 });
        section = { kind: "pbi", pbi };
      } else if (/^##\s+Acceptance criteria/i.test(line)) {
        section = { kind: "feature" };
      } else if (/^##\s+Definition of Done/i.test(line)) {
        section = { kind: "dod" };
      } else {
        section = { kind: "other" };
      }
      continue;
    }

    const box = CHECKBOX.exec(line);
    if (box) {
      const boxes =
        section.kind === "dod"
          ? dod
          : section.kind === "pbi"
            ? pbiBoxes.get(section.pbi)
            : undefined;
      if (boxes) {
        boxes.total++;
        if (box[1] !== " ") boxes.ticked++;
      }
    }
  }

  for (const [pbi, boxes] of pbiBoxes) pbi.ticked = allTicked(boxes);
  feature.closed = closedInPlan || allTicked(dod);
  return feature;
}

/** Returns the ids of the features ticked in a plan's Progress checklist. */
export function parseClosedFeatures(planText: string): Set<string> {
  const closed = new Set<string>();
  for (const line of planText.split(/\r?\n/)) {
    const box = CHECKBOX.exec(line);
    if (!box || box[1] === " ") continue;
    const link = /\(\.\/features\/([^)]+)\.md\)/.exec(line);
    if (link) closed.add(link[1]!);
  }
  return closed;
}

interface VitestJson {
  testResults?: {
    name?: string;
    assertionResults?: { title?: string; status?: string }[];
  }[];
}

/** Extracts the tests whose name starts with an `[AC-…]` tag from Vitest JSON results. */
export function parseVitestResults(json: VitestJson, root = ""): TaggedTest[] {
  const tests: TaggedTest[] = [];
  for (const fileResult of json.testResults ?? []) {
    const file =
      root && fileResult.name ? relative(root, fileResult.name) : (fileResult.name ?? "");
    for (const assertion of fileResult.assertionResults ?? []) {
      const title = assertion.title ?? "";
      const match = TEST_TAG.exec(title);
      if (match) tests.push({ tag: match[1]!, title, file, status: assertion.status ?? "unknown" });
    }
  }
  return tests;
}

export function checkAcceptance(features: Feature[], tests: TaggedTest[]): CheckResult {
  const errors: string[] = [];

  const known = new Map<string, string>();
  for (const feature of features) {
    const tags = [...feature.scenarios, ...feature.pbis.flatMap((p) => p.scenarios)].map(
      (s) => s.tag,
    );
    for (const tag of tags) {
      const first = known.get(tag);
      if (first !== undefined) {
        errors.push(`duplicate acceptance tag ${tag} in ${first} and ${feature.file}`);
      } else {
        known.set(tag, feature.file);
      }
    }
  }

  for (const test of tests) {
    if (!known.has(test.tag)) {
      errors.push(`unknown acceptance tag ${test.tag} (test "${test.title}" in ${test.file})`);
    }
  }

  const testsByTag = new Map<string, TaggedTest[]>();
  for (const test of tests) {
    testsByTag.set(test.tag, [...(testsByTag.get(test.tag) ?? []), test]);
  }

  let checkedScenarios = 0;
  const checkScenarios = (owner: string, scenarios: Scenario[]): void => {
    for (const scenario of scenarios) {
      checkedScenarios++;
      const tagged = testsByTag.get(scenario.tag) ?? [];
      if (tagged.length === 0) {
        errors.push(`${owner}: scenario ${scenario.tag} "${scenario.name}" has no test`);
        continue;
      }
      for (const test of tagged.filter((t) => t.status !== "passed")) {
        errors.push(
          `${owner}: scenario ${scenario.tag} "${scenario.name}" has a test that did not pass: ` +
            `"${test.title}" (${test.status})`,
        );
      }
    }
  };

  for (const feature of features) {
    if (feature.closed) {
      checkScenarios(`feature ${feature.id} (${feature.file}) is closed`, feature.scenarios);
    }
    for (const pbi of feature.pbis) {
      if (pbi.ticked) {
        checkScenarios(`PBI ${pbi.id} (${feature.file}) is ticked`, pbi.scenarios);
      } else if (feature.closed) {
        checkScenarios(`feature ${feature.id} (${feature.file}) is closed`, pbi.scenarios);
      }
    }
  }

  return { errors, checkedScenarios };
}

/** Loads every `docs/spec/<epic>/features/*.md` under `root`, applying each epic's plan Progress. */
export function loadFeatures(root: string): Feature[] {
  const specDir = join(root, "docs", "spec");
  if (!existsSync(specDir)) return [];
  const features: Feature[] = [];
  for (const epic of readdirSync(specDir, { withFileTypes: true })) {
    if (!epic.isDirectory()) continue;
    const epicDir = join(specDir, epic.name);
    const planPath = join(epicDir, "plan.md");
    const closed = existsSync(planPath)
      ? parseClosedFeatures(readFileSync(planPath, "utf8"))
      : new Set<string>();
    const featuresDir = join(epicDir, "features");
    if (!existsSync(featuresDir)) continue;
    for (const entry of readdirSync(featuresDir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const file = relative(root, join(featuresDir, entry)).replace(/\\/g, "/");
      const text = readFileSync(join(featuresDir, entry), "utf8");
      features.push(parseFeatureFile(text, file, closed.has(entry.replace(/\.md$/, ""))));
    }
  }
  return features;
}

export function run(argv: string[]): number {
  const option = (name: string, fallback: string): string => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
  };
  const root = resolve(option("--root", "."));
  const resultsPath = resolve(root, option("--results", "test-results/vitest.json"));

  if (!existsSync(resultsPath)) {
    console.error(`acceptance-coverage: no test results at ${resultsPath}; run "npm test" first`);
    return 1;
  }
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as VitestJson;
  const features = loadFeatures(root);
  const tests = parseVitestResults(results, root);
  const { errors, checkedScenarios } = checkAcceptance(features, tests);

  if (errors.length > 0) {
    console.error(`acceptance-coverage: ${errors.length} problem(s)`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(
    `acceptance-coverage: OK (${features.length} feature file(s), ` +
      `${checkedScenarios} required scenario(s), ${tests.length} tagged test(s))`,
  );
  return 0;
}

const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) {
  process.exitCode = run(process.argv.slice(2));
}
