# CatSpec user guide: spec

> Feature folder of the CatSpec user documentation (feature F9 `release-0-1`, PBI `user-guide`,
> [feature file](../reactive-ast-linked-spec-engine/features/release-0-1.md)). The product itself is
> specified in [`reactive-ast-linked-spec-engine`](../reactive-ast-linked-spec-engine/spec.md).

## What and why

People who install `catspec` need to learn it without reading the design documents. This folder is
the user guide of version 0.1: how to start, how to write specs and rules, what every diagnostic
means, how to connect an AI agent and a workflow, and what CatSpec can't do.

Readers: developers who add CatSpec to a TypeScript or C# repository, and the people who set up
their team's agents and SDD workflow.

## Pages

| Page | Content |
|---|---|
| [Quick start](./quick-start.md) | install, `init`, the first spec from draft to implemented, the commit hook |
| [Spec format](./spec-format.md) | `*.spec.md` frontmatter, bindings, members, body, statuses and how strictly each is enforced |
| [Rule catalogue](./rules.md) | structural, query, test and manual rules, global rules in the ADR log, waivers |
| [Diagnostics reference](./diagnostics.md) | every `CSxxxx` code: generated from the code registry |
| [Command reference](./commands.md) | every command and option: generated from `catspec --help` |
| [Agent integration](./agents.md) | MCP server, the `AGENTS.md` block, the Stop hook, `init --agents` |
| [Workflow presets](./workflow-presets.md) | `catspec`, `openspec`, `spec-kit` and `custom` workflows, stages and gates |
| [FAQ and known limits](./faq.md) | what syntax-only checking can and can't decide, and the limits of 0.1 |

## Requirements

- The guide describes the released CLI: nothing that doesn't exist, nothing missing. The
  diagnostics and command references are generated (`npm run guide`), and a test
  (`@AC-user-guide-1`) fails when they don't match the code registry and `catspec --help`.
- Hand-written pages link to the technical design (`plan.md` Part II) for the full detail instead
  of repeating it.
- Examples on the pages use the example repositories in [`examples/`](../../../examples/), which CI
  runs end to end (`@AC-example-repos-1`).
