/**
 * Acceptance-coverage check (plan §3 "How the Definition of Done is enforced", PBI `ci-pipeline`).
 *
 * Reads the Gherkin scenario tags (`@AC-…`) from every `docs/spec/<epic>/features/*.md`, finds the
 * PBIs whose boxes are all ticked and the features that are closed, and matches each scenario to
 * the tests whose name starts with its tag in brackets (`[AC-…]`), using the Vitest JSON results.
 *
 * Fails when:
 * - a ticked PBI or a closed feature has a scenario with no test, or with a test that didn't pass,
 *   or has no scenarios at all;
 * - a test is tagged with a tag that isn't in any feature file;
 * - the same tag appears twice in the feature files;
 * - a feature file breaks the tagging rules (plan §3): a scenario without exactly one `@AC-…` tag,
 *   an `@AC-…` tag that isn't on a scenario, or a scenario outside the acceptance criteria and PBIs.
 *
 * With `--all` (the release sweep, PBI `release-packaging`) every feature counts as closed, so every
 * scenario of every feature needs a passing test, and every MVP acceptance scenario of each epic's
 * `spec.md` §5 must be claimed by a feature in its `plan.md` §2 (`spec AC-n`).
 *
 * The CLI entry point is `scripts/check-acceptance.ts`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
  /** Violations of the tagging rules, reported whether or not anything is ticked. */
  problems: string[];
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
const GHERKIN_FENCES = new Set(["gherkin", "cucumber", "feature"]);
const SCENARIO_KEYWORD = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/;
const OTHER_KEYWORD = /^(Feature|Rule|Background|Examples|Scenarios):/;

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
  const feature: Feature = { id, file, closed: false, scenarios: [], pbis: [], problems: [] };
  const dod: Boxes = { total: 0, ticked: 0 };
  const pbiBoxes = new Map<Pbi, Boxes>();

  let section: Section = { kind: "other" };
  let fence: { gherkin: boolean } | undefined;
  let pendingTags: { tags: string[]; line: number } | undefined;

  const problem = (line: number, message: string): void => {
    feature.problems.push(`${file}:${line}: ${message}`);
  };
  const dropPendingTags = (why: string): void => {
    if (pendingTags) problem(pendingTags.line, `${pendingTags.tags.join(", ")} ${why}`);
    pendingTags = undefined;
  };

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const trimmed = line.trim();

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence) dropPendingTags("is not followed by a scenario");
      fence = fence ? undefined : { gherkin: GHERKIN_FENCES.has(fenceMatch[2]!.toLowerCase()) };
      continue;
    }

    if (!fence?.gherkin) {
      if (trimmed.startsWith("@AC-")) {
        problem(lineNo, `acceptance tag outside a \`\`\`gherkin block: ${trimmed}`);
      }
      if (fence) continue;
    } else {
      if (trimmed.startsWith("@")) {
        const tags = [...trimmed.matchAll(TAG_TOKEN)].map((m) => m[1]!);
        if (tags.length > 0) {
          pendingTags = { tags: [...(pendingTags?.tags ?? []), ...tags], line: lineNo };
        }
        continue;
      }
      const scenario = SCENARIO_KEYWORD.exec(trimmed);
      if (scenario) {
        const name = scenario[2]!;
        const tags = pendingTags?.tags ?? [];
        pendingTags = undefined;
        if (tags.length !== 1) {
          problem(
            lineNo,
            tags.length === 0
              ? `scenario "${name}" has no @AC tag`
              : `scenario "${name}" has more than one @AC tag: ${tags.join(", ")}`,
          );
        }
        if (tags[0] === undefined) continue;
        if (section.kind === "feature") feature.scenarios.push({ tag: tags[0], name });
        else if (section.kind === "pbi") section.pbi.scenarios.push({ tag: tags[0], name });
        else problem(lineNo, `scenario ${tags[0]} is not under "Acceptance criteria" or a PBI`);
        continue;
      }
      const other = OTHER_KEYWORD.exec(trimmed);
      if (other) dropPendingTags(`is on a "${other[1]}:" line, not on a scenario`);
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

  if (fence) dropPendingTags("is not followed by a scenario");
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
  const errors: string[] = features.flatMap((f) => f.problems);

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
    const tagged = testsByTag.get(test.tag);
    if (tagged) tagged.push(test);
    else testsByTag.set(test.tag, [test]);
  }

  let checkedScenarios = 0;
  const checkScenarios = (owner: string, scenarios: Scenario[]): void => {
    if (scenarios.length === 0) errors.push(`${owner}: it has no acceptance scenarios`);
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

/**
 * The MVP acceptance scenarios of a `spec.md` (the numbered items of §5 not marked Post-MVP) that
 * no feature of the `plan.md` §2 table claims with `spec AC-n`.
 */
export function unclaimedSpecScenarios(specText: string, planText: string): number[] {
  const mvp: number[] = [];
  let inScenarios = false;
  for (const line of specText.split(/\r?\n/)) {
    if (line.startsWith("## ")) inScenarios = /^##\s+5\./.test(line);
    const item = inScenarios ? /^(\d+)\.\s/.exec(line) : null;
    if (item && !/post-mvp/i.test(line)) mvp.push(Number(item[1]));
  }
  const claimed = new Set<number>();
  for (const line of planText.split(/\r?\n/)) {
    if (!/^\|\s*F\d+\s*\|/.test(line)) continue;
    for (const match of line.matchAll(/\bspec AC-(\d+)((?:,\s*AC-\d+)*)/g)) {
      claimed.add(Number(match[1]));
      for (const more of match[2]!.matchAll(/AC-(\d+)/g)) claimed.add(Number(more[1]));
    }
  }
  return mvp.filter((n) => !claimed.has(n));
}

/** `unclaimedSpecScenarios` of every epic under `root` that has a `spec.md` and a `plan.md`. */
export function checkSpecScenarios(root: string): string[] {
  const specDir = join(root, "docs", "spec");
  if (!existsSync(specDir)) return [];
  const errors: string[] = [];
  for (const epic of readdirSync(specDir, { withFileTypes: true })) {
    if (!epic.isDirectory()) continue;
    const spec = join(specDir, epic.name, "spec.md");
    const plan = join(specDir, epic.name, "plan.md");
    if (!existsSync(spec) || !existsSync(plan)) continue;
    for (const n of unclaimedSpecScenarios(
      readFileSync(spec, "utf8"),
      readFileSync(plan, "utf8"),
    )) {
      errors.push(
        `${relative(root, spec).replace(/\\/g, "/")}: MVP acceptance scenario ${n} is not ` +
          `claimed by any feature in plan.md §2 ("spec AC-${n}")`,
      );
    }
  }
  return errors;
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
  const all = argv.includes("--all");
  const features = loadFeatures(root).map((f) => (all ? { ...f, closed: true } : f));
  const tests = parseVitestResults(results, root);
  const { errors, checkedScenarios } = checkAcceptance(features, tests);
  if (all) errors.push(...checkSpecScenarios(root));

  if (errors.length > 0) {
    console.error(`acceptance-coverage: ${errors.length} problem(s)`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(
    `acceptance-coverage: OK${all ? " (release sweep: every scenario)" : ""} (${features.length} feature file(s), ` +
      `${checkedScenarios} required scenario(s), ${tests.length} tagged test(s))`,
  );
  return 0;
}
