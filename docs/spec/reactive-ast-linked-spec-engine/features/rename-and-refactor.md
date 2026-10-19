# F6 · `rename-and-refactor`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1.5 w · Depends on: F5 [`git-integration-and-hook`](./git-integration-and-hook.md) · Acceptance: `@AC-F6-1..4` (spec AC-2, AC-3, AC-11, AC-12).
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

Renaming and moving code is normal, and it shouldn't break specs or create manual
work. Moving a file needs nothing at all. Renaming a class or method is detected and the spec is
fixed with one command. Even a big refactor (a namespace renamed across 40 classes) is mapped in
one batch, and what has already passed is never lost. CatSpec only ever fixes where things are;
it never weakens what the spec requires.

## Requirements covered

analysis C2, C3; F-6, F-7, F-8 · plan §D11.4, §D11.6, §D11.8 · ADR-005,
ADR-008, ADR-013, ADR-016.

## Acceptance criteria

```gherkin
Feature: F6 rename-and-refactor

  @AC-F6-1
  Scenario: A renamed class is healed (spec AC-2)
    Given an implemented spec bound to class UserHandler and heal.mode "suggest"
    When the class is renamed to UserUpdatedHandler and I commit
    Then the hook fails with CS0210 and shows the patch
    When I run "catspec sync --apply"
    Then the spec points to UserUpdatedHandler and the next commit passes

  @AC-F6-2
  Scenario: A moved file needs nothing (spec AC-3)
    Given an implemented spec bound to AuthService
    When AuthService.ts is moved to another folder without renaming
    Then "catspec check" passes with no edits

  @AC-F6-3
  Scenario: A mass refactor is mapped in one batch (spec AC-11)
    Given 40 bound classes in namespace Identity
    When the namespace is renamed to Accounts and the folder is moved in one commit
    Then the hook shows one CS0215 instead of 40 errors
    When I run "catspec sync --apply"
    Then all 40 bindings point to the new names, satisfied items are kept, and the commit passes

  @AC-F6-4
  Scenario: Ambiguous renames are never guessed (spec AC-12)
    Given two near-identical handlers renamed at the same time without a rename map
    When I run "catspec sync --apply"
    Then CS0216 lists the candidates and no spec is changed
    But with "--map renames.json" the sync succeeds
```

New diagnostics: `CS0210` renamed (with the patch; in the hook it takes the severity of the
`CS0201` it replaces, and it is `info` for body mentions and stale `file` hints), `CS0215` large
refactor summary, `CS0216` ambiguous mapping, `CS0217` binding lost. The "class renamed and its body rewritten" example of
`@AC-rename-detection-1` is tested as the class's members rewritten, since an unchanged
name-free fingerprint maps a class whatever its method bodies are (plan §D11.8, row 5).
`catspec bind` writes the binding id (last segment of the name), `kind`, `exported`, all bases as
`implements`, attribute names, `constructor.requires` and the public members with parameters and
return types (overloads: name and kind only); it writes `file` only with `--file`. Matching and
sync details: plan §D11.4 and §D11.8.

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F6-1..4` are automated and pass in CI on 3 OSes
- [ ] requirements review done; differences approved by the owner
- [ ] `catspec stage finish close rename-and-refactor` passes
- [ ] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `rename-detection`
Works out where a vanished symbol went: moved, file renamed, or renamed in place, with a confidence score.
- depends on: `hook-installer`
- refs: §D11.4, analysis F-7
- [x] moved → file renamed (`git diff -M`) → symbol renamed with score
- [x] body-token similarity (Jaccard over token 3-grams, computed on demand)

```gherkin
  @AC-rename-detection-1
  Scenario Outline: Rename detection outcomes
    Given the change "<change>"
    When rename detection runs
    Then the result is "<result>"
    Examples:
      | change                                      | result                 |
      | class renamed, same members                 | renamed, score ≥ 0.8   |
      | class renamed and moved to a renamed file   | renamed                |
      | two similar classes renamed                 | ambiguous              |
      | class renamed and its body rewritten        | below threshold, none  |
```

## PBI `sync-command`
`catspec sync`: shows the spec edits a rename needs and applies them safely.
- depends on: `rename-detection`, `spec-cst-editor`
- refs: §D10, §D11.4, §D11.6, ADR-008
- [x] location-only `SpecPatch`; CS0210 with the patch
- [x] `catspec sync` (dry-run diff) / `sync --apply`; `heal.mode=auto` applies and re-stages in the hook
- [x] body mentions of old names → info; rewritten only with `--update-mentions`

```gherkin
  @AC-sync-command-1
  Scenario: Dry run changes nothing
    Given a detected rename
    When I run "catspec sync"
    Then a diff is printed and no file is changed

  @AC-sync-command-2
  Scenario: Automatic edits never touch contracts
    Given any detected rename, including one where members also changed
    When "catspec sync --apply" runs
    Then only "symbol" and "file" values are changed in the spec
```

## PBI `bind-command`
`catspec bind`: writes a binding for code that already exists, so specs for existing code are quick to create.
- depends on: `spec-cst-editor`, `binding-resolver`
- refs: §D10
- [x] `catspec bind <symbol> --spec <id> [--file f]`: binding scaffolded from the current shape

```gherkin
  @AC-bind-command-1
  Scenario: A new binding passes immediately
    Given class AuthService with three public methods
    When I run "catspec bind AuthService --spec auth"
    Then the spec contains a binding with those three members
    And "catspec check --spec auth" prints DONE
```

## PBI `batch-rename-mapping`
Maps many renamed symbols at once using the strongest evidence first, and keeps the history of what passed.
- depends on: `sync-command`
- refs: §D11.8, ADR-013
- [x] baseline capture (refactor baseline, or `HEAD`); name-free fingerprints
- [x] rename map `--map` (`symbols` / `namespaces` / `paths`); prefix-rule detection
- [x] global one-to-one assignment; report mapped / ambiguous (CS0216) / lost (CS0217)
- [x] lock entries moved to the new ids (ratchet survives); name-only shape changes auto-accepted

```gherkin
  @AC-batch-rename-mapping-1
  Scenario: Namespace rename (spec AC-11)
    Given 40 bound classes renamed from Identity.* to Accounts.*
    When "catspec sync --apply" runs
    Then all 40 are mapped by the prefix rule and their satisfied items move with them

  @AC-batch-rename-mapping-2
  Scenario: One new class is never used twice
    Given two broken bindings whose best candidate is the same new class
    When mapping runs
    Then at most one of them is mapped to it and the other is reported as ambiguous or lost

  @AC-batch-rename-mapping-3
  Scenario: Lost bindings block
    Given a bound class deleted with no candidate
    When "catspec sync --apply" runs during a refactor
    Then CS0217 is reported and the refactor stays open
```

## PBI `refactor-mode`
`catspec refactor`: a snapshot before a multi-commit refactor, finished by `sync --apply`.
- depends on: `batch-rename-mapping`
- refs: §D11.8, ADR-016
- [x] `catspec refactor [--scope] [--reason] [--allow-wip]`, `refactor status`, `refactor abort`; baseline in the runtime store
- [x] during a refactor, `sync --apply` ends it on success; `--partial` keeps it open
- [x] hook: one grouped CS0215 above `refactor.detect_threshold`; `--allow-wip` only on the recorded branch

```gherkin
  @AC-refactor-mode-1
  Scenario: Multi-commit refactor with WIP commits
    Given "catspec refactor --scope 'src/accounts/**' --allow-wip" on branch "rename-accounts"
    When I make three intermediate commits with broken bindings
    Then the hook lets them through on that branch with one CS0215 warning
    And on any other branch the same breakage is blocked

  @AC-refactor-mode-2
  Scenario: Abort leaves no trace
    Given an active refactor
    When I run "catspec refactor abort"
    Then the baseline is deleted and no spec has changed
```
