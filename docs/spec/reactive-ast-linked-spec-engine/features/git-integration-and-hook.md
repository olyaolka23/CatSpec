# F5 · `git-integration-and-hook`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1.5 w · Depends on: F3 [`rule-engine-and-check`](./rule-engine-and-check.md) · Acceptance: `@AC-F5-1..4` (spec AC-4, AC-5).
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

This is the safety net: a pre-commit hook that checks exactly what you are about
to commit and blocks commits that break a contract. It is fast enough not to annoy (under a
second). It never blocks work in progress, but it does block regressions: once something has
passed, it can't silently break again. It also notices when a signature changes without the spec
being updated.

## Requirements covered

analysis C2, C7; F-1, F-4, F-8, F-9, F-16 · plan §D7, §D8, §D11.7, §D13 ·
ADR-004, ADR-006, ADR-009.

## Acceptance criteria

```gherkin
Feature: F5 git-integration-and-hook

  @AC-F5-1
  Scenario: Regression is blocked, progress is not (spec AC-4)
    Given an in-progress spec whose method login is still missing
    When I commit
    Then the hook warns and the commit succeeds
    When login is implemented and committed, and later deleted and committed again
    Then the hook blocks the commit with CS0301

  @AC-F5-2
  Scenario: Only staged content counts (spec AC-5)
    Given a correct version of AuthService.ts is staged and a broken version is in the working tree
    When I commit
    Then the hook passes
    But with the broken version staged and the correct one in the working tree, the hook fails

  @AC-F5-3
  Scenario: The hook is fast
    Given the 10k-file fixture repository with a warm cache
    When a commit touches up to 20 bound files
    Then the hook finishes in under 1 second

  @AC-F5-4
  Scenario: Existing hooks keep working
    Given a repository using husky with an existing pre-commit script
    When I run "catspec install-hooks"
    Then both the existing script and catspec run on commit
```

`@AC-F5-3` is asserted on the time of the check itself; the time as a new process (startup
included) is logged by the test. New diagnostics: `CS0108` orphan lock file (warning), `CS0300`
drift (severity from `enforcement.drift`), `CS0301` regression (error), `CS0902` git not found
(error). Lock file details and hook behaviour: plan §D7 and §D13.

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F5-1..4` are automated and pass in CI on 3 OSes
- [ ] requirements review done; differences approved by the owner
- [ ] `catspec stage finish close git-integration-and-hook` passes
- [ ] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `git-access`
A small, safe layer for talking to git: no shell, batched reads, and clear errors when git is missing.
- depends on: `check-command`
- refs: §D11.3, ADR-009
- [ ] `execFile` wrapper, never a shell; long-lived `git cat-file --batch`
- [ ] `ls-files -s -z`, `diff --cached -M --name-status -z`, `rev-parse --git-common-dir --show-toplevel`
- [ ] CS0902 when git is missing; temp-repo test helper `withRepo(fn)`

```gherkin
  @AC-git-access-1
  Scenario: Hostile file names are harmless
    Given a staged file named 'a;rm -rf ~;$(touch pwned).ts'
    When CatSpec reads it from the index
    Then its content is read correctly and no command is executed

  @AC-git-access-2
  Scenario: No git available
    Given git is not on PATH
    When I run "catspec check --staged"
    Then CS0902 explains that git is required, and the exit code is 1
```

## PBI `source-providers`
Lets every check read files from the working tree, the git index or an older revision through one interface.
- depends on: `git-access`
- refs: §D11.3, analysis F-9
- [ ] `WorkingTreeProvider`, `IndexProvider`, `RevisionProvider`

```gherkin
  @AC-source-providers-1
  Scenario: Same content, same result
    Given identical content in the working tree, the index and HEAD
    When the same check runs with each provider
    Then all three produce identical diagnostics
```

## PBI `staged-check`
`catspec check --staged`: checks the commit being made, and only what it touches.
- depends on: `source-providers`
- refs: §D11.3, §D13
- [ ] scope = changed files ∪ files of changed specs ∪ bound files from the lock files

```gherkin
  @AC-staged-check-1
  Scenario: Partial staging (spec AC-5)
    Given a correct version staged and a broken version unstaged
    When I run "catspec check --staged"
    Then it exits 0
    But in the reverse situation it exits 1

  @AC-staged-check-2
  Scenario: Untouched files are not parsed
    Given a commit changing one bound file in a repository with 1000 bound files
    When I run "catspec check --staged"
    Then only the changed file and the specs bound to it are evaluated
```

## PBI `lock-files`
Writes the observed state of each spec (what passed, resolved locations, signatures) to a generated file next to the spec.
- depends on: `source-providers`
- refs: §D7, ADR-004
- [ ] `<spec-id>.lock.json` next to each spec: deterministic writer, per-item spec hash
- [ ] `catspec baseline --rebuild`; CS0108 lock file without a spec

```gherkin
  @AC-lock-files-1
  Scenario: Deterministic output
    Given an unchanged repository
    When "catspec baseline --rebuild" runs twice
    Then the lock files are byte-identical

  @AC-lock-files-2
  Scenario: Orphan lock file
    Given "login.lock.json" without "login.spec.md"
    When I run "catspec check --specs-only"
    Then CS0108 is reported
```

## PBI `ratchet`
Remembers what has passed once, so it can never silently break again, even while a spec is still in progress.
- depends on: `lock-files`
- refs: §D7.1, ADR-006, analysis F-4
- [ ] passing items added to `satisfied`; regression → CS0301 even when `in-progress`
- [ ] items invalidated when their part of the spec changes

```gherkin
  @AC-ratchet-1
  Scenario: Regression of a satisfied item (spec AC-4)
    Given an in-progress spec whose member login passed and was recorded
    When login is deleted
    Then CS0301 is an error

  @AC-ratchet-2
  Scenario: Changing the spec resets the item
    Given member login was satisfied
    When the spec changes login's declared return type
    Then login is no longer in "satisfied" until it passes again
```

## PBI `drift-and-accept`
Detects signature changes of implemented specs that the spec doesn't mention, and lets you accept them on purpose.
- depends on: `lock-files`
- refs: §D7.2, analysis F-8
- [ ] shape fingerprints (bodies excluded); CS0300 for `implemented` specs per `enforcement.drift`
- [ ] `catspec accept <spec>`

```gherkin
  @AC-drift-and-accept-1
  Scenario: Signature change is drift, body change is not
    Given an implemented spec bound to login(user: string)
    When the body of login changes
    Then no drift is reported
    But when the signature becomes login(user: string, otp: string), CS0300 is reported

  @AC-drift-and-accept-2
  Scenario: Accepting a change
    Given CS0300 for login
    When I run "catspec accept <spec>"
    Then the next check reports no drift
```

## PBI `hook-installer`
Installs the pre-commit hook safely next to existing hook tools and keeps generated lock files in the commit.
- depends on: `staged-check`, `ratchet`
- refs: §D13
- [ ] `install-hooks` / `uninstall-hooks`: plain git, `core.hooksPath`, husky, lefthook; chain and back up foreign hooks
- [ ] the hook updates and re-stages lock files of touched specs (`hook.stage_generated`); `CATSPEC_SKIP=1`
- [ ] `init --hooks`

```gherkin
  @AC-hook-installer-1
  Scenario: Foreign hook is not overwritten
    Given an existing .git/hooks/pre-commit not created by CatSpec
    When I run "catspec install-hooks" without --force
    Then it refuses and explains how to chain it

  @AC-hook-installer-2
  Scenario: Uninstall restores the previous hook
    Given CatSpec was installed with --force over an existing hook
    When I run "catspec uninstall-hooks"
    Then the original hook is restored byte-for-byte
```
