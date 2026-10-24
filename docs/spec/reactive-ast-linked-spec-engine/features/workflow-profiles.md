# F8 · `workflow-profiles`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1 w · Depends on: F7 [`mcp-server-and-agent-layer`](./mcp-server-and-agent-layer.md) · Acceptance: `@AC-F8-1..3` (spec AC-14, AC-15, AC-16).
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

Teams already plan with OpenSpec, Spec Kit or their own skills. With one section in
`catspec.yaml`, CatSpec learns those steps, tells the agent what comes next and with which skill,
and checks each step when it starts and finishes. Nothing in the team's workflow has to change.

## Requirements covered

analysis F-20 · plan §D17 · ADR-015, ADR-016.

## Acceptance criteria

```gherkin
Feature: F8 workflow-profiles

  @AC-F8-1
  Scenario: Custom sdd skills are gated (spec AC-14)
    Given preset custom with stages spec, plan, task, close driven by skills sdd-spec, sdd-plan, sdd-task, sdd-close
    And feature login has spec.md but no plan.md
    When I run "catspec next login"
    Then it names stage plan and skill sdd-plan
    And "catspec stage finish close login" fails with CS0702 (contracts_pass) while login() is missing
    But once login() exists, it succeeds and sets the spec to implemented

  @AC-F8-2
  Scenario: OpenSpec archive is gated (spec AC-15)
    Given preset openspec and the change openspec/changes/add-login/
    When I run "catspec stage start archive add-login" while a contract fails or a task is unticked
    Then it is refused
    And after archiving, the change's *.spec.md is still enforced

  @AC-F8-3
  Scenario: Doctor finds a missing skill (spec AC-16)
    Given a config naming skill sdd-plan that doesn't exist under skills_dir
    When I run "catspec workflow doctor"
    Then CS0704 names sdd-plan and the expected path
```

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F8-1..3` are automated and pass in CI on 3 OSes
- [ ] requirements review done; differences approved by the owner
- [x] `catspec stage finish close workflow-profiles` passes
- [ ] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `workflow-config`
The `workflow:` section of `catspec.yaml`: stages, who drives them, what they produce and which gates apply.
- depends on: `mcp-resources-and-prompts` (F7; F7's `claude-code-validation` runs after F8)
- refs: §D17.1, §D17.2
- [x] schema: presets, stages, `per: feature|spec`, drivers (`skill`, `slash`, `command`, `manual`), `produces`, `start` / `finish` gates and statuses, placeholders `{feature}`, `{feature_dir}`, `{spec}`
- [x] CS0700 invalid config; JSON Schema export

```gherkin
  @AC-workflow-config-1
  Scenario: Unknown gate name
    Given a stage with "finish: { gates: [contracts_passed] }"
    When the config is loaded
    Then CS0700 names "contracts_passed" and suggests "contracts_pass"

  @AC-workflow-config-2
  Scenario: Unknown placeholder
    Given produces "{featur_dir}/plan.md"
    When the config is loaded
    Then CS0700 names the placeholder and lists the valid ones
```

## PBI `stage-resolution`
Works out where each feature and work item currently is in the workflow, without storing any extra state.
- depends on: `workflow-config`
- refs: §D17.1, ADR-004
- [x] derive the current stage per feature and per work item
- [x] feature targets for `per: spec` stages (run for every spec of the feature)

```gherkin
  @AC-stage-resolution-1
  Scenario: Current stage follows the artifacts
    Given feature login with spec.md and valid specs but no plan.md
    When the current stage is resolved
    Then it is "plan"
    And after plan.md is added and its gates pass, it is "task" for each ready work item

  @AC-stage-resolution-2
  Scenario: A per-spec stage on a feature runs for every spec
    Given feature user-account-management with 6 specs
    When "stage finish close user-account-management" is resolved
    Then the close gates are evaluated for all 6 specs
```

## PBI `gate-runner`
Runs the named checks (gates) when a stage starts or finishes.
- depends on: `stage-resolution`
- refs: §D17.4, §D17.7, ADR-009
- [x] gates `specs_valid`, `artifacts`, `contracts_declared`, `deps_known`, `deps_ready`, `contracts_pass`, `tasks_done`, `no_drift`, `adr_valid`
- [x] `command:` gates only with `workflow.allow_commands`, via `execFile` (CS0706 when skipped)
- [x] CS0701 / CS0702 / CS0705

```gherkin
  @AC-gate-runner-1
  Scenario Outline: Each gate passes and fails correctly
    Given a fixture where gate <gate> should <outcome>
    When the gate runs
    Then it <outcome>
    Examples:
      | gate               | outcome |
      | specs_valid        | pass    |
      | artifacts          | fail    |
      | deps_ready         | fail    |
      | contracts_pass     | pass    |
      | tasks_done         | fail    |
      | no_drift           | pass    |

  @AC-gate-runner-2
  Scenario: Shell gates are off by default
    Given a gate "command: openspec validate {feature}" and allow_commands false
    When the gate runs
    Then nothing is executed and CS0706 is reported
```

## PBI `workflow-cli`
The workflow commands: `next`, `stage start|finish`, and `workflow show|doctor|snippet`.
- depends on: `gate-runner`
- refs: §D10, §D17.5
- [x] `catspec next <feature>`; `catspec stage start|finish <stage> <feature|spec-id> [--force]`
- [x] `catspec workflow show [feature]`, `workflow doctor` (CS0704), `workflow snippet <stage|agents>`

```gherkin
  @AC-workflow-cli-1
  Scenario: next lists ready and waiting work items
    Given register-api is ready and email-verification depends on it
    When I run "catspec next user-account-management"
    Then register-api is listed as ready with stage task and skill sdd-task
    And email-verification is listed as waiting on register-api

  @AC-workflow-cli-2
  Scenario: Starting too early is refused
    Given login-api is not implemented
    When I run "catspec stage start task token-refresh"
    Then it is refused with CS0701 (deps_ready) naming login-api
    But with --force it starts and the override is logged
```

## PBI `workflow-mcp`
The workflow for agents over MCP: `next_step`, `start_stage`, `finish_stage` and per-stage prompts.
- depends on: `workflow-cli`
- refs: §D14.1, §D17.5
- [x] MCP `next_step`, `start_stage`, `finish_stage`; `workflow` block in `get_spec_context`; generated `stage-<id>` prompts

```gherkin
  @AC-workflow-mcp-1
  Scenario: MCP and CLI agree
    Given the same repository state
    When next_step is called over MCP and "catspec next" runs on the CLI
    Then both name the same stage, driver and gates
```

## PBI `workflow-presets`
Ready-made profiles for CatSpec's own flow, custom skills, OpenSpec and Spec Kit, detected automatically by `init`.
- depends on: `workflow-cli`
- refs: §D17.3
- [x] presets `catspec` and `custom`
- [x] presets `openspec` and `spec-kit`: first verify their current layouts and command names, then pin per preset version; fixture repos for both
- [x] detection in `catspec init` (`openspec/`, `.specify/`, `sdd-*` skills)

```gherkin
  @AC-workflow-presets-1
  Scenario: init detects OpenSpec
    Given a repository with an "openspec/" folder
    When I run "catspec init"
    Then it proposes preset openspec

  @AC-workflow-presets-2
  Scenario: Every preset is internally consistent
    Given each preset's fixture repository
    When I run "catspec workflow doctor"
    Then it reports no problems
```

## PBI `workflow-hook`
Optionally re-checks, on every commit, that implemented specs still pass their final workflow gates, without slowing the hook.
- depends on: `gate-runner`, `hook-installer`
- refs: §D17.5
- [x] `workflow.enforce_in_hook`: CS0703 for `implemented` specs, built-in gates only (never `command:`)

```gherkin
  @AC-workflow-hook-1
  Scenario: Shell gates never run in the hook
    Given a final stage with a command: gate and enforce_in_hook "error"
    When the pre-commit hook runs
    Then the command gate is not executed and the hook stays under 1 second
```
