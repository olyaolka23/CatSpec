/**
 * `catspec init` (plan §D3): creates `catspec.yaml`, so `catspec check --specs-only` passes right
 * away. The architecture spec is optional (ADR-028): `--with-adr` writes one, and a folder of ADRs
 * the repository already has is written to `specs.architecture`. `--with-sdd-example` writes an
 * example feature folder. Existing files are never overwritten.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  architectureMatcher,
  CONFIG_FILE,
  customWorkflowYaml,
  detectPreset,
  featureDirYaml,
  findSddSkills,
  isArchitectureSpecText,
  kebabCase,
  listFiles,
  loadConfig,
  resolveWorkflow,
  WorkflowSchema,
  type PresetName,
} from "@catspec/core";

export const EXAMPLE_FEATURE = "example-feature";
export const EXAMPLE_SPEC = "example-greeter";

export interface InitResult {
  root: string;
  created: string[];
  skipped: { file: string; reason: string }[];
  /** The workflow preset written to `catspec.yaml`. */
  preset: PresetName;
  /** True when the preset was found from what is in the repository (plan §D17.3). */
  detected: boolean;
  /** The folder of ADRs the repository already had, written to `specs.architecture`. */
  adrFolder?: string;
}

/** Folders where repositories commonly keep their ADRs, in the order `init` looks for them. */
export const ADR_FOLDERS = [
  "docs/adr",
  "docs/adrs",
  "docs/decisions",
  "docs/architecture/adr",
  "docs/architecture/decisions",
  "doc/adr",
  "doc/architecture/decisions",
  "architecture/decisions",
  "adr",
];

/** The first folder of `ADR_FOLDERS` with a Markdown file in it. */
export function findAdrFolder(root: string): string | undefined {
  return ADR_FOLDERS.find((folder) => {
    try {
      return readdirSync(join(root, folder)).some((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      return false;
    }
  });
}

/** The file name of the architecture spec `--with-adr` writes into a folder of existing ADRs. */
export const RULES_FILE = "architecture-rules.md";

/** Creates the CatSpec layout in `root`. `name` names the ADR log (`<name>-adr.md`). */
export async function initRepository(
  root: string,
  options: {
    name?: string;
    date?: string;
    preset?: PresetName;
    withExample?: boolean;
    withAdr?: boolean;
  } = {},
): Promise<InitResult> {
  const name = kebabCase(options.name ?? basename(root)) || "project";
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const detected = options.preset === undefined ? detectPreset(root) : undefined;
  const preset = options.preset ?? detected ?? "catspec";
  const result: InitResult = {
    root,
    created: [],
    skipped: [],
    preset,
    detected: detected !== undefined,
  };

  const write = async (file: string, content: string): Promise<void> => {
    const path = join(root, file);
    if (existsSync(path)) {
      result.skipped.push({ file, reason: "already exists" });
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    result.created.push(file);
  };

  // ADRs the repository already has: CatSpec reads them where they are (ADR-028).
  const adrFolder = existsSync(join(root, CONFIG_FILE)) ? undefined : findAdrFolder(root);
  if (adrFolder) result.adrFolder = adrFolder;

  // The custom preset names only the sdd-* skills the repository has, where it has them.
  await write(
    CONFIG_FILE,
    configTemplate(preset, findSddSkills(root), adrFolder, options.withAdr === true),
  );

  // The architecture spec is optional: written only with --with-adr, and never a second one
  // next to an existing one (CS0107).
  if (options.withAdr) {
    const { config } = await loadConfig(root);
    const isArchitecture = architectureMatcher(config.specs.architecture);
    const existing: string[] = [];
    for (const file of (await listFiles(root)).filter((f) => isArchitecture(f))) {
      if (isArchitectureSpecText(await readFile(join(root, file), "utf8"))) existing.push(file);
    }
    // Into the ADR folder when `specs.architecture` names one, else at the default path.
    const configured = config.specs.architecture.replace(/\/+$/, "");
    const folder =
      /[*?[\]{}()!]/.test(configured) || /\.md$/i.test(configured) ? undefined : configured;
    const adrFile = folder ? `${folder}/${RULES_FILE}` : `docs/architecture/adr/${name}-adr.md`;
    if (!folder && !isArchitecture(adrFile)) {
      result.skipped.push({
        file: adrFile,
        reason: `specs.architecture is "${config.specs.architecture}": create the architecture spec there`,
      });
    } else if (existing.length > 0) {
      result.skipped.push({
        file: adrFile,
        reason: `an architecture spec already exists: ${existing.join(", ")}`,
      });
    } else {
      await write(adrFile, folder ? rulesTemplate(name) : adrTemplate(name, date));
    }
  }

  if (!options.withExample) return result;
  // OpenSpec and Spec Kit keep their own feature folders: no example under docs/spec/.
  if (preset === "openspec" || preset === "spec-kit") {
    result.skipped.push({
      file: `docs/spec/${EXAMPLE_FEATURE}/`,
      reason: `the ${preset} preset keeps its features in ${resolveWorkflow(WorkflowSchema.parse({ preset })).featureDir}`,
    });
    return result;
  }
  for (const [file, content] of Object.entries(exampleFeatureFiles())) await write(file, content);
  return result;
}

type SddSkills = ReturnType<typeof findSddSkills>;

/**
 * The `workflow:` section for a preset (plan §D17.2, §D17.3). It spells out the preset's
 * `feature_dir` and `skills_dir`, so they are easy to find and change.
 */
const workflowTemplate = (preset: PresetName, found: SddSkills): string => {
  if (preset === "custom") return customWorkflowYaml(found?.skills ?? [], found?.skillsDir);
  const { featureDir, skillsDir } = resolveWorkflow(WorkflowSchema.parse({ preset }));
  return `# The SDD workflow CatSpec gates (plan §D17): catspec | openspec | spec-kit | custom.
workflow:
  preset: ${preset}
${featureDirYaml(featureDir)}
  skills_dir: "${skillsDir}"  # where \`skill:\` drivers are found
  allow_commands: false  # let \`command:\` gates run commands
  enforce_in_hook: warn  # off | warn | error
`;
};

/** The `specs.architecture` line: the ADR folder found, the file `--with-adr` writes, or a
 * commented example (the architecture spec is optional, ADR-028). */
const architectureLine = (adrFolder: string | undefined, withAdr: boolean): string =>
  adrFolder
    ? `  # Your ADRs (optional): a file, a glob or a folder. One file here may hold CatSpec's
  # repository-wide rules (type: architecture); the others are read only for their ADR ids.
  architecture: "${adrFolder}"`
    : withAdr
      ? `  # Your ADRs and the repository-wide rules (optional): a file, a glob or a folder.
  architecture: "docs/architecture/adr/*-adr.md"`
      : `  # Optional: where your ADRs are (a file, a glob or a folder), if you want CatSpec to check
  # repository-wide rules. \`catspec init --with-adr\` writes a starter file.
  # architecture: "docs/adr"`;

const configTemplate = (
  preset: PresetName,
  found: SddSkills,
  adrFolder?: string,
  withAdr = false,
): string => {
  const profile = resolveWorkflow(WorkflowSchema.parse({ preset }));
  return `# yaml-language-server: $schema=./node_modules/@catspec/core/schemas/catspec.schema.json
# CatSpec configuration. Every key is optional and has a default.
version: 1
layout: ${profile.layout}
${workflowTemplate(preset, found)}specs:
  # include defaults to the *.spec.md files in each workflow.feature_dir folder:
  # [${profile.specsInclude.map((g) => `"${g}"`).join(", ")}]
${architectureLine(adrFolder, withAdr)}
# Both languages are always on; a file's extension picks its language. Point the globs at your
# sources, or set \`include: []\` to leave a language out.
languages:
  typescript:
    include: ["src/**/*.{ts,tsx}"]
    exclude: ["**/*.d.ts", "**/node_modules/**"]
  csharp:
    include: ["src/**/*.cs"]
    exclude: ["**/obj/**", "**/bin/**", "**/*.g.cs"]
`;
};

/** The ADR log `init` writes (also used by `uninstall` to see whether it is unchanged). */
export const adrTemplate = (name: string, date: string): string => `---
catspec: 1
id: architecture
title: ${name} architecture
type: architecture
status: draft
# Global rules, checked over the whole codebase. Each rule names the decision it enforces (adr: ADR-NNN).
rules: []
---

# Architecture Decision Records

This file is the architecture spec of the repository:

- the **frontmatter** holds the global rules that CatSpec checks over the whole codebase;
- the **body** is the decision log: one \`## ADR-NNN: <title>\` section per decision.

Append each new decision with the next number; never renumber or delete one. To change a
decision, add a new ADR that supersedes it. When a decision can be checked in code, add a rule
to the frontmatter with \`adr: ADR-NNN\`.

## ADR-001: Record architecture decisions

- **Status:** Accepted · **Date:** ${date}
- **Context:** Everyone working on the code, people and agents, needs to know why it is built the way it is.
- **Decision:** Every architecture decision is recorded in this log.
- **Consequences:** Decisions are easy to find, and the checkable ones become rules in the frontmatter.
`;

/** The architecture spec `--with-adr` writes into a folder of existing ADRs: only the rules,
 * the decisions stay in their own files (also used by `uninstall`). */
export const rulesTemplate = (name: string): string => `---
catspec: 1
id: architecture
title: ${name} architecture rules
type: architecture
status: draft
# Repository-wide rules, checked over the whole codebase. A rule may name the ADR it enforces
# (adr: ADR-NNN): the ADR files next to this one, by the number in their file name.
rules: []
---

# Architecture rules

CatSpec checks the rules in the frontmatter of this file over the whole codebase. The
decisions themselves stay in the other files of this folder.
`;

/** The example feature `init` writes, by path (also used by `uninstall`). */
export const exampleFeatureFiles = (): Record<string, string> => {
  const feature = `docs/spec/${EXAMPLE_FEATURE}`;
  return {
    [`${feature}/spec.md`]: featureSpecTemplate(),
    [`${feature}/plan.md`]: featurePlanTemplate(),
    [`${feature}/${EXAMPLE_SPEC}.spec.md`]: exampleSpecTemplate(),
  };
};

const featureSpecTemplate = (): string => `# Example feature — Spec

> What and why: the problem, goals, users and acceptance scenarios of the feature. The technical
> design goes in [\`plan.md\`](./plan.md), the machine-checked contract in
> [\`${EXAMPLE_SPEC}.spec.md\`](./${EXAMPLE_SPEC}.spec.md). Replace this example with a real feature.

## Goals

- Greet users by name.
`;

const featurePlanTemplate = (): string => `# Example feature — Plan

> How: the technical design and the order of work for [\`spec.md\`](./spec.md).

## Work items

1. [\`${EXAMPLE_SPEC}\`](./${EXAMPLE_SPEC}.spec.md): a \`Greeter\` class with a \`greet\` method.
`;

const exampleSpecTemplate = (): string => `---
catspec: 1
id: ${EXAMPLE_SPEC}
title: Greeter
type: feature
status: draft
bindings:
  - id: greeter
    symbol: Greeter
    kind: class
    members:
      - name: greet
        kind: method
rules:
  - id: no-console
    class: structural
    forbid_call: "console.log"
    within: greeter
---

# Greeter

An example spec. It binds the class \`Greeter\` and forbids console logging inside it. Its status is
\`draft\`, so nothing is enforced until it moves to \`in-progress\`.

## Contracts

- [binding:greeter] \`Greeter\` has a method \`greet\`.
- [rule:no-console] \`Greeter\` doesn't log to the console.

## Tasks

- [ ] Write the \`Greeter\` class.
- [ ] Set the status to \`implemented\` when its checks pass.
`;
