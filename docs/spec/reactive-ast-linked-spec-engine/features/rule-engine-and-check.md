# F3 · `rule-engine-and-check`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1.5 w · Depends on: F2 [`typescript-language-support`](./typescript-language-support.md) · Acceptance: `@AC-F3-1..5` (spec AC-1, AC-6, AC-7).
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

The first version you can actually use. You write a spec saying "AuthService must
have login()", run `catspec check`, and get a clear answer: it passes, or here is what's missing and
where. Architecture rules ("Domain must not import Infrastructure"), spec statuses and dependency
order are enforced. From the end of this feature, CatSpec checks its own repository.

## Requirements covered

analysis C1, C4, C5, C7; F-2, F-3, F-4, F-5, F-6, F-11, F-12, F-14, F-17
· plan §D6, §D8, §D10, §D11.3, §D11.5, §D12 · ADR-003, ADR-005, ADR-006, ADR-007, ADR-011.

## Acceptance criteria

```gherkin
Feature: F3 rule-engine-and-check

  @AC-F3-1
  Scenario: A renamed method is caught (spec AC-1)
    Given an implemented spec binding AuthService with member validateToken
    When validateToken is renamed to checkToken and I run "catspec check"
    Then it exits 1 with CS0203 "member validateToken missing"
    And it suggests "did you mean checkToken?" with the file and line

  @AC-F3-2
  Scenario: Architecture rule (spec AC-6)
    Given an architecture rule forbidding imports from src/Domain/** to src/Infrastructure/**
    When a Domain file imports an Infrastructure module and I run "catspec check"
    Then CS0603 is reported with the importing file and line

  @AC-F3-3
  Scenario: Dependencies gate status changes (spec AC-7)
    Given user-sync-handler depends on cdc-core-events, which is not implemented
    When I run "catspec status user-sync-handler in-progress"
    Then it is refused with CS0502 naming cdc-core-events

  @AC-F3-4
  Scenario: The agent report says DONE or NOT DONE
    Given a spec whose contracts all pass
    When I run "catspec check --spec <id>"
    Then the last line is "DONE" and the exit code is 0
    But if one member is missing, the report lists expected, found and fix, ends with "NOT DONE" and exits 1

  @AC-F3-5
  Scenario: CatSpec checks itself
    Given the CatSpec repository with its ADR rules enforced
    When a change makes packages/core import web-tree-sitter
    Then CI fails on "catspec check" with CS0603 (ADR-003 rule)
```

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F3-1..5` are automated and pass in CI on 3 OSes
- [ ] requirements review done; differences approved by the owner
- [ ] `catspec stage finish close rule-engine-and-check` passes (first feature closed by CatSpec itself)
- [ ] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `binding-resolver`
Finds the code symbol a binding points to, even if the file has moved, and suggests the closest names when it can't find it.
- depends on: `parse-cache-and-index`, `spec-loader`
- refs: §D11.5, ADR-005
- [ ] resolution order: `file` hint → lock-file path (from F5) → repo-wide index
- [x] CS0201 not found with did-you-mean (Damerau-Levenshtein, same kind, same file first); CS0202 ambiguous

```gherkin
  @AC-binding-resolver-1
  Scenario: A moved file still resolves
    Given a binding to AuthService with file hint "src/services/AuthService.ts"
    And the class now lives in "src/auth/AuthService.ts"
    When the binding is resolved
    Then it resolves to the new file without errors

  @AC-binding-resolver-2
  Scenario: Two candidates are ambiguous
    Given two non-partial classes named AuthService in different folders and no file hint
    When the binding is resolved
    Then CS0202 lists both locations
```

## PBI `contract-evaluator`
Checks a resolved symbol against its binding: kind, visibility, base types, attributes, members, signatures and constructor dependencies.
- depends on: `binding-resolver`
- refs: §D5.3, §D11.5, analysis F-5
- [x] kind, exported / visibility, `implements` / `extends` (normalised suffix), attributes / decorators
- [x] members: existence, kind, positional params with `*`, returns, modifiers, `optional`
- [x] `constructor.requires`; CS0220 when syntax can't decide
- [x] every check emits its own item id (`binding:auth.login`) for the ratchet (F5)

```gherkin
  @AC-contract-evaluator-1
  Scenario: Signature mismatch
    Given member validateToken declared with params [string] and returns Promise<boolean>
    And the code has validateToken(token: string): boolean
    When the contract is evaluated
    Then CS0205 reports expected Promise<boolean>, found boolean

  @AC-contract-evaluator-2
  Scenario: Missing DI dependency
    Given "constructor.requires: [ILogger, IEventStore]"
    And the only constructor takes ILogger
    When the contract is evaluated
    Then CS0207 reports IEventStore missing

  @AC-contract-evaluator-3
  Scenario: Undecidable cases are not false errors
    Given "implements: [IHandler]" and a class whose base is an alias defined in another file
    When the contract is evaluated
    Then CS0220 "unresolvable" is reported with the configured severity, not CS0204
```

## PBI `structural-rules`
Implements the rule catalogue: forbidden and required calls, import boundaries, naming rules and deprecated symbols.
- depends on: `contract-evaluator`
- refs: §D6.2
- [x] `forbid_call`, `require_call`, `forbid_import`, `allow_import_only`, `naming`, `must_not_exist`
- [x] `within` (binding / member ranges) and `paths` scoping

```gherkin
  @AC-structural-rules-1
  Scenario: Forbidden call inside the bound class only
    Given rule forbid_call "console.*" within binding "auth"
    And console.log is called in AuthService and in another class
    When rules are evaluated
    Then exactly one CS0601 is reported, for AuthService

  @AC-structural-rules-2
  Scenario: Naming rule
    Given rule naming: classes named "*Handler" must implement IMessageHandler<*>
    And class UserHandler doesn't
    When rules are evaluated
    Then CS0604 is reported for UserHandler
```

## PBI `query-and-test-rules`
Supports raw Tree-sitter queries as an escape hatch, and rules that require a linked test to exist (and optionally pass).
- depends on: `contract-evaluator`
- refs: §D6.1, §D6.3, analysis F-2
- [x] `query` rules: compiled at spec load (CS0130 invalid), `expect: absent|present` (CS0610)
- [x] `test` rules: test symbol must exist (CS0620); `--run-tests` runs `tests.command` via `execFile` (CS0621)

```gherkin
  @AC-query-and-test-rules-1
  Scenario: Invalid query is reported when specs load
    Given a query rule with unbalanced parentheses
    When specs are loaded
    Then CS0130 is reported at that rule, before any code is parsed

  @AC-query-and-test-rules-2
  Scenario: Missing linked test
    Given a test rule pointing to "UserUpdatedHandlerTests.HandleAsync_IsIdempotent"
    And no such test exists
    When I run "catspec check"
    Then CS0620 names the missing test

  @AC-query-and-test-rules-3
  Scenario: Tests run only when asked
    Given a test rule whose test exists but fails
    When I run "catspec check" without --run-tests
    Then no test is executed
    But with --run-tests, CS0621 is reported
```

## PBI `architecture-rules`
Applies the rules in the ADR log's frontmatter to the whole repository.
- depends on: `structural-rules`
- refs: §D6.4, analysis F-12
- [x] rules from the architecture spec apply repo-wide; a `draft` architecture spec is not enforced

```gherkin
  @AC-architecture-rules-1
  Scenario: Repo-wide import rule (spec AC-6)
    Given the ADR log forbids imports from src/Domain/** to src/Infrastructure/**
    When any Domain file imports Infrastructure
    Then CS0603 is reported, whether or not the file is bound by a spec

  @AC-architecture-rules-2
  Scenario: Draft architecture spec is not enforced
    Given the same rule in an ADR log with status draft
    When I run "catspec check"
    Then no CS0603 is reported
```

## PBI `status-and-waivers`
Makes enforcement depend on a spec's status, supports waivers with a reason and expiry, and provides the `status` command.
- depends on: `contract-evaluator`, `dependency-graph`
- refs: §D6.5, §D8, analysis F-4, F-17
- [x] enforcement matrix by status (the ratchet arrives in F5)
- [x] waivers with reason and `until` (CS0400 waived, CS0401 expired)
- [x] `catspec status <spec> <status> [--force]`: `implemented` only if `check --spec` passes; `in-progress` only if dependencies are implemented (CS0502)

```gherkin
  @AC-status-and-waivers-1
  Scenario: In-progress specs warn
    Given an in-progress spec with a missing member
    When I run "catspec check"
    Then CS0203 is a warning and the exit code is 0

  @AC-status-and-waivers-2
  Scenario: Expired waiver
    Given a waiver for rule no-console with "until: 2026-01-01" and today is later
    When I run "catspec check"
    Then CS0401 is reported as an error

  @AC-status-and-waivers-3
  Scenario: implemented requires passing contracts
    Given a spec with one failing contract
    When I run "catspec status <id> implemented"
    Then it is refused and the failing contract is listed
```

## PBI `check-command`
The main `catspec check` command, plus the agent-friendly `--spec` report and the `coverage` report.
- depends on: `structural-rules`, `query-and-test-rules`, `status-and-waivers`
- refs: §D10, §D11.3, analysis F-3, F-14
- [x] `catspec check [paths] [--spec <id>…] [--specs-only]` over the working tree
- [x] `--spec`: expected / found / fix per item, ends with DONE / NOT DONE, exit 0 = done
- [x] `catspec coverage`: contract satisfaction, enforcement coverage, reverse coverage; `manual` rules and CS0111 counted
- [x] diagnostic message snapshot tests (wording is UX)

```gherkin
  @AC-check-command-1
  Scenario: Missing member with did-you-mean (spec AC-1)
    Given an implemented spec requiring AuthService.validateToken
    And the code has checkToken instead
    When I run "catspec check"
    Then CS0203 is reported with "did you mean checkToken?" and the code location

  @AC-check-command-2
  Scenario: Coverage report
    Given 4 enforceable rules (3 passing) and 1 manual rule
    When I run "catspec coverage"
    Then contract satisfaction is 75% and enforcement coverage is 80%
```

## PBI `dogfood-specs`
CatSpec starts checking its own repository: the ADR rules are enforced and the first machine specs are added.
- depends on: `check-command`, `architecture-rules`
- refs: plan §0 (dogfooding), ADR-003
- [x] `catspec.yaml` for this repo; propose switching the ADR log frontmatter from `draft` to enforced (owner approval, Rule 3)
- [x] propose the first machine specs in the epic folder, e.g. `core-public-api.spec.md` binding `LanguageAdapter` and `FileFacts` (owner approval, Rule 3)
- [x] `catspec check` runs in this repo's CI

```gherkin
  @AC-dogfood-specs-1
  Scenario: The repo's own contracts are checked in CI (ADR-003)
    Given the CatSpec repository with enforced ADR rules
    When packages/core imports web-tree-sitter
    Then the "catspec check" CI step fails with CS0603
```
