# F0 · `repo-scaffolding`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 0.5 w · Depends on: — · Acceptance: `@AC-F0-1..2`.
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

Before any feature can be built, the project needs a home: a monorepo with all
packages, a build, tests, and CI that runs on every operating system we support. This feature
also sets up the gates that keep the Definition of Done honest from the very first PR: the
acceptance-coverage check and the PR template.

## Requirements covered

plan §D11.1 (packages), spec §4 (platforms, quality) · ADR-001

## Acceptance criteria

```gherkin
Feature: F0 repo-scaffolding

  @AC-F0-1
  Scenario: A fresh clone builds and tests on every supported platform
    Given a fresh clone of the repository on Linux, macOS or Windows with Node 20 or 22
    When I run "npm ci" and then "npm test"
    Then every package builds
    And every test passes

  @AC-F0-2
  Scenario: Ticking a PBI without tests is rejected
    Given a PBI whose boxes are all ticked in its feature file
    And one of its scenario tags has no test
    When CI runs on the pull request
    Then the acceptance-coverage check fails and names the missing tag
```

## Definition of Done (feature)
- [x] all PBIs meet the PBI checklist
- [x] `@AC-F0-1..2` are automated and pass in CI on 3 OSes
- [x] requirements review done; differences approved by the owner
- [x] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `monorepo-setup`
Creates the npm-workspaces monorepo with every package and the shared build, test and lint tooling.
- depends on: —
- [x] npm workspaces: `packages/{core,lang,lang-typescript,lang-csharp,cli,mcp,catspec}`
- [x] TypeScript 5 strict, ESM, shared `tsconfig`; `tsup` builds per package
- [x] `vitest` with one placeholder test per package; `eslint` + `prettier`
- [x] `changesets` for versioning; `npm run build|test|lint|typecheck` at the root

```gherkin
  @AC-monorepo-setup-1
  Scenario: Root scripts work across all packages
    Given the monorepo with seven packages
    When I run "npm run build", "npm run lint", "npm run typecheck" and "npm test" at the root
    Then each command succeeds and covers every package
```

## PBI `ci-pipeline`
Runs every check on every pull request and enforces the Definition of Done automatically.
- depends on: `monorepo-setup`
- [x] GitHub Actions: lint, typecheck, test on Linux × Node 20 / 22 for every PR; on macOS and Windows only when the PR has the label `full-ci-mac` or `full-ci-win`; npm cache; lint warnings fail
- [x] **acceptance-coverage script** (`scripts/check-acceptance.ts`): parses the `@AC-…` tags in `features/*.md`, finds which PBIs are fully ticked and which features are closed, and matches tags to test names (`[AC-…]`) and results
- [x] the script runs as a required CI step
- [x] PR template `.github/pull_request_template.md` with the PBI checklist (propose the text to the owner first; Rule 3)
- [x] ask the owner to enable branch protection on `main`: required CI, owner approval

```gherkin
  @AC-ci-pipeline-1
  Scenario: CI runs on Linux for every PR, and on macOS or Windows by label
    Given a pull request
    When CI runs
    Then lint, typecheck and tests run on Linux with Node 20 and Node 22
    And they also run on macOS when the PR has the label "full-ci-mac", and on Windows when it has "full-ci-win"

  @AC-ci-pipeline-2
  Scenario: A ticked PBI with a failing tagged test fails CI
    Given a PBI whose boxes are all ticked
    And the test tagged "[AC-<pbi-id>-1]" fails
    When the acceptance-coverage check runs
    Then it fails and names the PBI and the failing scenario

  @AC-ci-pipeline-3
  Scenario: Unticked PBIs don't need tests yet
    Given a PBI with unticked boxes and no tests
    When the acceptance-coverage check runs
    Then it passes for that PBI

  @AC-ci-pipeline-4
  Scenario: A test tag that is not in any feature file fails CI
    Given a test named "[AC-unknown-1] …"
    When the acceptance-coverage check runs
    Then it fails with "unknown acceptance tag AC-unknown-1"
```

## PBI `fixture-conventions`
Defines how test fixtures (small sample repositories) are laid out and loaded, so all later features test the same way.
- depends on: `monorepo-setup`
- [x] `fixtures/<name>/{repo files, catspec.yaml, docs/spec/<feature>/, docs/architecture/adr/<name>-adr.md, expected.json}`
- [x] test helper `loadFixture(name)` that copies a fixture into a temporary directory
- [x] `CONTRIBUTING.md` pointing to `AGENTS.md`, the ADR log and `plan.md` (propose the text first; Rule 3)

```gherkin
  @AC-fixture-conventions-1
  Scenario: A fixture is isolated per test
    Given the fixture "sample"
    When two tests load it and one of them modifies files
    Then the other test still sees the original fixture
```
