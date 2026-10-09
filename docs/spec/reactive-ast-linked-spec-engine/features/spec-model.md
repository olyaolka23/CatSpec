# F1 · `spec-model`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1.5 w · Depends on: F0 [`repo-scaffolding`](./repo-scaffolding.md) · Acceptance: `@AC-F1-1..4`.
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

CatSpec has to understand spec files before it can check any code. This feature
reads `*.spec.md` files and the config, validates them with clear error messages that point to the
exact line, builds the dependency graph between specs, and can edit spec files without destroying
their formatting. At the end you can run `catspec init` and `catspec check --specs-only` in a real
repository.

## Requirements covered

analysis C1, C5, C9; F-1, F-2, F-11, F-12, F-15, F-17 · plan §D3, §D4, §D5,
§D6 (parsing), §D8 (statuses), §D12 (CS01xx) · ADR-004, ADR-008, ADR-011, ADR-012, ADR-017.

## Acceptance criteria

```gherkin
Feature: F1 spec-model

  @AC-F1-1
  Scenario: init creates a working layout
    Given an empty git repository
    When I run "catspec init"
    Then catspec.yaml, docs/spec/<example-feature>/ and docs/architecture/adr/<name>-adr.md exist
    And "catspec check --specs-only" exits 0

  @AC-F1-2
  Scenario: Spec errors point to the exact line
    Given a spec whose binding has "kind: klass" on line 9
    When I run "catspec check --specs-only"
    Then it exits 1
    And it reports CS0101 at the spec file, line 9, listing the allowed kinds

  @AC-F1-3
  Scenario: Dependency cycles are reported with the full path
    Given specs a → b → c → a via depends_on
    When I run "catspec check --specs-only"
    Then it reports CS0105 with the cycle "a → b → c → a"

  @AC-F1-4
  Scenario: The dependency graph can be exported
    Given specs with depends_on relations
    When I run "catspec graph --format mermaid"
    Then the output is a valid mermaid graph with one node per spec and one edge per dependency
```

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F1-1..4` are automated and pass in CI on 3 OSes
- [ ] requirements review done; differences approved by the owner
- [ ] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `diagnostics-core`
Defines what an error or warning looks like everywhere in CatSpec (code, severity, location, message) and how it is printed.
- depends on: `monorepo-setup`
- refs: §D12, §D10 (exit codes)
- [ ] `Diagnostic` type: code, severity, spec / code location, message, expected / actual, suggestions
- [ ] code registry (code → default severity, title, docs text)
- [ ] reporters `text` and `json`; exit codes 0 / 1 / 2 / 3

```gherkin
  @AC-diagnostics-core-1
  Scenario: Exit code reflects the worst severity
    Given diagnostics with only warnings
    When they are reported
    Then the exit code is 0
    But with at least one error the exit code is 1

  @AC-diagnostics-core-2
  Scenario: Unregistered codes are rejected
    Given code that emits diagnostic "CS9999", which is not in the registry
    When the tests run
    Then a test fails naming "CS9999"

  @AC-diagnostics-core-3
  Scenario: JSON output is machine-readable
    Given two diagnostics
    When reported with "--format json"
    Then the output is valid JSON with code, severity, locations and message for both
```

## PBI `config-loader`
Reads and validates `catspec.yaml` so every command uses the same settings, and a mistake in the config is reported clearly.
- depends on: `diagnostics-core`
- refs: §D4
- [ ] zod schema for `catspec.yaml` incl. `layout`, `languages`, `enforcement`, `heal`, `hook`, `refactor`, `mcp` (`workflow` is validated in F8)
- [ ] defaults; discovery of the root `catspec.yaml` (walk up to the git root)
- [ ] JSON Schema export into `schemas/` for editor autocompletion

```gherkin
  @AC-config-loader-1
  Scenario: Missing config uses the defaults
    Given a repository without catspec.yaml
    When the config is loaded
    Then every value equals the default in plan §D4

  @AC-config-loader-2
  Scenario: Invalid value is reported with key, line and allowed values
    Given catspec.yaml containing "heal.mode: sometimes" on line 12
    When the config is loaded
    Then an error names "heal.mode", line 12 and the allowed values "off, suggest, auto"

  @AC-config-loader-3
  Scenario: Config is found from a subfolder
    Given catspec.yaml at the repository root
    When a command runs from "src/services"
    Then the root catspec.yaml is used
```

## PBI `frontmatter-parser`
Splits a spec file into its YAML header and Markdown body and remembers exact positions for error messages.
- depends on: `diagnostics-core`
- refs: §D5
- [ ] split the `---` block with exact byte offsets; body kept byte-for-byte
- [ ] parse with `yaml` `parseDocument` (CST + line / column positions)

```gherkin
  @AC-frontmatter-parser-1
  Scenario Outline: Positions are correct
    Given a spec file with <shape>
    When it is parsed
    Then the line and column of every frontmatter key are correct
    Examples:
      | shape                    |
      | nested keys              |
      | Windows line endings     |
      | no Markdown body         |

  @AC-frontmatter-parser-2
  Scenario: A file without frontmatter is an error, not a crash
    Given a ".spec.md" file without a "---" header
    When it is parsed
    Then CS0101 is reported for line 1
```

## PBI `spec-schema`
Validates the meaning of the spec header (bindings, members, rules, waivers) and turns shorthand forms into the full model.
- depends on: `frontmatter-parser`
- refs: §D5.2, §D5.3, §D6.1–6.3, §D6.5, §D17.1 (aggregate specs)
- [ ] zod for frontmatter, bindings and members, rules (common fields `id`, `class`, `message`, `adr`, `paths`), waivers
- [ ] shorthand normalisation (`members: ["login"]`)
- [ ] map validation issue paths → YAML node ranges → `specLocation`
- [ ] CS0101 invalid schema, CS0102 unknown key (warning); aggregate spec detection

```gherkin
  @AC-spec-schema-1
  Scenario: Shorthand members expand to full members
    Given a binding with "members: [login, logout]"
    When the spec is validated
    Then the model has two members named "login" and "logout" of any kind, not optional

  @AC-spec-schema-2
  Scenario: Unknown keys only warn
    Given a spec with the top-level key "jira: ABC-1"
    When the spec is validated
    Then CS0102 is reported as a warning and the spec is still loaded

  @AC-spec-schema-3
  Scenario: Aggregate specs are recognised
    Given a spec with depends_on but no bindings and no rules
    When the spec is validated
    Then it is marked as an aggregate spec
```

## PBI `body-parser`
Reads the human part of a spec: references to rules, unenforced invariants and the task checklist.
- depends on: `frontmatter-parser`
- refs: §D5.4
- [ ] remark → `[rule:id]` / `[binding:id]` references (CS0110 for unknown ids)
- [ ] bullets under `Contracts` / `Invariants` without a reference → CS0111
- [ ] `## Tasks` checklist → done / total

```gherkin
  @AC-body-parser-1
  Scenario: Unknown reference is an error
    Given a body bullet "[rule:no-consol] No console logging" and no rule "no-consol"
    When the spec is loaded
    Then CS0110 is reported at that line

  @AC-body-parser-2
  Scenario: Prose invariant without a rule is reported
    Given a bullet under "## Contracts" without any [rule:] or [binding:] reference
    When the spec is loaded
    Then CS0111 "unenforced prose invariant" is reported

  @AC-body-parser-3
  Scenario: Task progress is counted
    Given "## Tasks" with 3 items, 2 of them ticked
    When the spec is loaded
    Then progress is 2 of 3
```

## PBI `spec-loader`
Finds all specs in the repository, indexes them and checks repo-level rules (unique ids, folder layout, ADR log location).
- depends on: `config-loader`, `spec-schema`, `body-parser`
- refs: §D3, §D4, §D6.4, §D12
- [ ] discover specs via `specs.include`; build `SpecSet` (id → spec, file → specs)
- [ ] CS0103 duplicate id; CS0106 spec outside a feature folder (`layout: feature-folders`)
- [ ] architecture spec at `specs.architecture`: CS0107 missing or ambiguous; CS0112 rule referencing an unknown ADR id

```gherkin
  @AC-spec-loader-1
  Scenario: Duplicate ids are reported in both files
    Given two spec files with "id: login"
    When specs are loaded
    Then CS0103 is reported with both file paths

  @AC-spec-loader-2
  Scenario: Spec outside a feature folder
    Given "docs/login.spec.md" and layout "feature-folders"
    When specs are loaded
    Then CS0106 suggests moving it to "docs/spec/<feature>/"

  @AC-spec-loader-3
  Scenario: Rule referencing an unknown ADR
    Given an architecture rule with "adr: ADR-099" and no ADR-099 in the log
    When specs are loaded
    Then CS0112 is reported at that rule
```

## PBI `dependency-graph`
Builds the graph of `depends_on` relations so CatSpec knows the order of work and which specs are ready.
- depends on: `spec-loader`
- refs: §D8, analysis F-11
- [ ] DAG from `depends_on`; CS0104 unknown dependency; CS0105 cycle with the full path (Tarjan SCC)
- [ ] topological order; "ready" computed from statuses

```gherkin
  @AC-dependency-graph-1
  Scenario: Unknown dependency
    Given a spec with "depends_on: [payments]" and no spec "payments"
    When the graph is built
    Then CS0104 names "payments" and the spec that needs it

  @AC-dependency-graph-2
  Scenario: Ready specs
    Given spec B depends on A, and A is implemented
    When ready specs are listed
    Then B is ready
    But if A is in-progress, B is not ready
```

## PBI `spec-cst-editor`
Edits spec headers without destroying comments or formatting, and separates safe "location" edits from "contract" edits.
- depends on: `frontmatter-parser`
- refs: §D11.6, ADR-008
- [ ] `applyPatch(spec, ops)` via `Document.setIn/deleteIn`; keeps comments, key order, quoting
- [ ] the body stays byte-for-byte identical
- [ ] golden round-trip suite and a fast-check property test
- [ ] patch ops classified as **location** or **contract**

```gherkin
  @AC-spec-cst-editor-1
  Scenario: A no-op edit changes nothing
    Given any fixture spec file
    When it is parsed and written back without changes
    Then the file is byte-for-byte identical

  @AC-spec-cst-editor-2
  Scenario: Comments survive an edit
    Given a binding with a comment on its "file:" line
    When the "symbol" value is changed
    Then the comment, the key order and the Markdown body are unchanged

  @AC-spec-cst-editor-3
  Scenario: Patches are classified
    Given a patch that changes "symbol" and a patch that removes a member
    When they are classified
    Then the first is a location edit and the second is a contract edit
```

## PBI `cli-skeleton`
The first usable `catspec` command line: `init`, `check --specs-only`, `list`, `show`, `graph`.
- depends on: `config-loader`, `dependency-graph`
- refs: §D3, §D10
- [ ] `commander` CLI; global flags `--cwd --config --format text|json --no-color --quiet --verbose`
- [ ] `catspec init`: `catspec.yaml`, `docs/spec/<example-feature>/` (spec.md, plan.md, one `*.spec.md`), `docs/architecture/adr/<name>-adr.md`
- [ ] `catspec check --specs-only`, `list [--status] [--ready]`, `show <spec>`, `graph --format mermaid|dot|json`

```gherkin
  @AC-cli-skeleton-1
  Scenario: list filters by readiness
    Given specs A (implemented), B (ready, depends on A) and C (ready, depends on B)
    When I run "catspec list --ready"
    Then the output lists B and not C

  @AC-cli-skeleton-2
  Scenario: Usage errors use exit code 2
    Given any repository
    When I run "catspec graph --format png"
    Then it exits 2 with the allowed formats
```
