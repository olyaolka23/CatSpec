/**
 * `catspec init` (plan §D3): creates `catspec.yaml`, an example feature folder and the ADR log,
 * so `catspec check --specs-only` passes right away. Existing files are never overwritten.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CONFIG_FILE, globMatcher, kebabCase, listFiles, loadConfig } from "@catspec/core";

export const EXAMPLE_FEATURE = "example-feature";
export const EXAMPLE_SPEC = "example-greeter";

export interface InitResult {
  root: string;
  created: string[];
  skipped: { file: string; reason: string }[];
}

/** Creates the CatSpec layout in `root`. `name` names the ADR log (`<name>-adr.md`). */
export async function initRepository(
  root: string,
  options: { name?: string; date?: string } = {},
): Promise<InitResult> {
  const name = kebabCase(options.name ?? basename(root)) || "project";
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const result: InitResult = { root, created: [], skipped: [] };

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

  await write(CONFIG_FILE, configTemplate());

  // One ADR log per repository: don't add a second one next to an existing log (CS0107).
  const { config } = await loadConfig(root);
  const isArchitecture = globMatcher(config.specs.architecture);
  const existing = (await listFiles(root)).filter((f) => isArchitecture(f));
  const adrFile = `docs/architecture/adr/${name}-adr.md`;
  if (existing.length > 0) {
    result.skipped.push({
      file: adrFile,
      reason: `an ADR log already exists: ${existing.join(", ")}`,
    });
  } else {
    await write(adrFile, adrTemplate(name, date));
  }

  const feature = `docs/spec/${EXAMPLE_FEATURE}`;
  await write(`${feature}/spec.md`, featureSpecTemplate());
  await write(`${feature}/plan.md`, featurePlanTemplate());
  await write(`${feature}/${EXAMPLE_SPEC}.spec.md`, exampleSpecTemplate());
  return result;
}

const configTemplate =
  (): string => `# yaml-language-server: $schema=./node_modules/@catspec/core/schemas/catspec.schema.json
# CatSpec configuration. Every key is optional and has a default.
version: 1
layout: feature-folders
specs:
  include: ["docs/spec/*/*.spec.md"]
  architecture: "docs/architecture/adr/*-adr.md"
`;

const adrTemplate = (name: string, date: string): string => `---
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
