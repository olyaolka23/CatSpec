# F9 · `release-0-1`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1 w · Depends on: F4 [`csharp-language-support`](./csharp-language-support.md), F8 [`workflow-profiles`](./workflow-profiles.md) · Acceptance: `@AC-F9-1..3` (all MVP spec AC).
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

Turns the working pieces into a release people can install and trust: proven fast
on large repositories, robust against strange files, documented, with example projects, and
published as `catspec` 0.1.0.

## Requirements covered

analysis F-16 · spec §4 (non-functional), spec §5 (all MVP acceptance
scenarios)

## Acceptance criteria

```gherkin
Feature: F9 release-0-1

  @AC-F9-1
  Scenario: Install on a clean machine
    Given a clean Linux, macOS or Windows machine with Node 22.12 or newer
    When I run "npx catspec init" in a new git repository and then "npx catspec check"
    Then both succeed without a native build step

  @AC-F9-2
  Scenario: Performance budgets
    Given the synthetic 10k-file repository
    When the benchmark job runs
    Then the staged check takes at most 1.1 seconds warm and the full check at most 10.5 seconds cold

  @AC-F9-3
  Scenario: The whole epic is verified
    Given the release candidate
    When the acceptance suite runs
    Then every MVP spec acceptance scenario (AC-1–7, 9–12, 14–17) and every feature scenario passes on 3 OSes
```

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F9-1..3` are automated and pass in CI on 3 OSes
- [ ] requirements review of the whole epic against spec §4 and spec §5; differences approved by the owner
- [ ] `catspec stage finish close reactive-ast-linked-spec-engine` passes (epic closed)
- [ ] owner approved the release and ticking it in plan §1 Progress

## PBI `performance-budgets`
Measures and enforces the speed targets on a large synthetic repository.
- depends on: `workflow-hook`, `csharp-acceptance`
- refs: §D11.7, spec §4, analysis F-16
- [ ] synthetic 10k-file repo generator (TS + C#)
- [ ] benchmark job: staged ≤ 1.1 s warm, full ≤ 10.5 s cold; profile and fix hot spots

```gherkin
  @AC-performance-budgets-1
  Scenario: A slower commit fails the benchmark
    Given a change that makes the warm staged check take 1.3 seconds
    When the benchmark job runs
    Then it fails and reports the measured time against the 1.1-second budget
```

## PBI `robustness-fuzzing`
Makes sure no input file, however broken or huge, can crash CatSpec.
- depends on: `csharp-acceptance`
- refs: spec §4
- [ ] fuzz both adapters with random / truncated files (no throws); skip huge files with CS0901

```gherkin
  @AC-robustness-fuzzing-1
  Scenario: Random input never crashes
    Given 10,000 random and truncated TypeScript and C# files
    When facts are extracted from each
    Then no exception escapes and every failure is a CS0901 diagnostic
```

## PBI `user-guide`
The user documentation, kept in its own feature folder and checked against the real CLI.
- depends on: `workflow-presets`
- refs: spec §4 (docs)
- [ ] propose the feature folder `docs/spec/catspec-user-guide/` and its content to the owner (Rule 3): quick start, spec format, rule catalogue, diagnostics reference (generated from the code registry), agent integration, workflow presets, FAQ on syntactic limits
- [ ] propose updating `README.md` from "design stage" to the released state (Rule 3)

```gherkin
  @AC-user-guide-1
  Scenario: Docs match the CLI
    Given the diagnostics reference and the command reference in the user guide
    When they are compared with the code registry and "catspec --help"
    Then every code and every command is documented and none is documented that doesn't exist
```

## PBI `example-repos`
Two example projects that show the full journey, in TypeScript and in .NET.
- depends on: `workflow-presets`
- refs: plan §2
- [ ] `examples/ts-auth-service` (the `AuthService` journey) and `examples/dotnet-user-sync` (`UserUpdatedHandler`)

```gherkin
  @AC-example-repos-1
  Scenario: Examples stay working
    Given both example repositories
    When CI runs their scripted journeys
    Then each ends with all specs implemented and "catspec check" exiting 0
```

## PBI `release-packaging`
Packages and publishes 0.1.0 after the final acceptance sweep.
- depends on: `performance-budgets`, `robustness-fuzzing`, `user-guide`, `example-repos`
- refs: spec §4, spec §5
- [ ] `catspec` meta-package (CLI + MCP + adapters); `npx catspec init` smoke test on clean machines (3 OSes)
- [ ] final acceptance sweep: spec AC-1–7, 9–12, 14–17 and all feature scenarios in CI
- [ ] publish 0.1.0 with changesets only after the owner's approval; release notes with the known limits

```gherkin
  @AC-release-packaging-1
  Scenario: Publishing needs a green sweep and approval
    Given the release candidate
    When the acceptance sweep is green and the owner approves
    Then 0.1.0 is published to npm with release notes listing the known limits
```

## Implementation notes

- Budgets: 1.1 s staged warm and 10.5 s full cold (owner's decision, 2026-10-24; first targets
  1 s and 10 s). Benchmark and cache changes: plan §D11.7.
- `robustness-fuzzing`: `test/robustness-fuzzing.test.ts` runs 10,000 fast-check inputs (random
  text, random syntax, truncated and cut fixtures) through both adapters; the limit for parsing is
  1 MiB (`MAX_SOURCE_BYTES`, plan §D11.2).
- `user-guide`: [`docs/spec/catspec-user-guide/`](../../catspec-user-guide/spec.md). Its diagnostics and command
  references are generated (`npm run guide`); `@AC-user-guide-1` checks them and every code and
  command the guide and README name.
- `example-repos`: [`examples/ts-auth-service`](../../../../examples/ts-auth-service/) and
  [`examples/dotnet-user-sync`](../../../../examples/dotnet-user-sync/); `test/example-repos.test.ts` runs
  their journeys (spec AC-1 and AC-2).
- `release-packaging`: `catspec` has the `catspec` bin; `test/clean-install.test.ts` packs every
  package and runs `npx catspec init` and `check` after an install with `--ignore-scripts`.
  `npm run check:acceptance -- --all` is the sweep. `.github/workflows/release.yml` (started by hand)
  publishes with `changeset publish` after the sweep on 3 OSes and the approval of the `npm-release`
  environment; the release notes are `.changeset/release-0-1.md`.
