# Rule catalogue

Rules are invariants beyond a binding's shape. They live under `rules:` in a spec, or in the
optional architecture spec's frontmatter for rules over the whole repository. The full design is in
[plan §D6](../reactive-ast-linked-spec-engine/plan.md#d6-rules-invariants).

## Rule classes

| `class` | Checked by | Blocks a commit |
|---|---|---|
| `structural` | the rule engine, on the declarations, imports and calls of each file | yes, by spec status |
| `query` | a Tree-sitter query you write, on the files in scope | yes |
| `test` | the linked test must exist; it runs only with `check --run-tests` | yes (the test must exist) |
| `manual` | nobody: tracked so it isn't forgotten | never |

Every rule has an `id` and a `class`, and may have `message` (your text in the diagnostic), `adr`
(the ADR it enforces) and `paths` (globs that narrow the files). `within: <binding>` or
`within: <binding>.<member>` limits a rule to that code; without it the scope is the spec's
resolved files, or every source file for a global rule.

## Structural rules

| Key | Fails when | Code |
|---|---|---|
| `forbid_call: "<pattern>"` | a call's callee matches (`*` is a wildcard: `console.*`) | CS0601 |
| `require_call: "<pattern>"` | no matching call in the scope | CS0602 |
| `forbid_import: { from: <glob>, to: [<pattern>…] }` | a file under `from` imports a module matching `to` | CS0603 |
| `allow_import_only: { from: <glob>, to: [<pattern>…] }` | a file under `from` imports anything else (standard library aside) | CS0603 |
| `naming: { kind, name, implements / extends / attributes / in_path }` | a matching declaration breaks the convention | CS0604 |
| `must_not_exist: { symbol, kind }` | the declaration exists (deprecations) | CS0605 |

```yaml
rules:
  - id: domain-is-pure
    class: structural
    adr: ADR-007
    forbid_import:
      from: "src/Domain/**"
      to: ["src/Infrastructure/**"]
```

## Query rules

```yaml
- id: no-sync-over-async
  class: query
  lang: csharp
  query: |
    (member_access_expression name: (identifier) @n (#eq? @n "Result")) @hit
  expect: absent            # absent | present
  within: handler
  message: "Do not block on Task.Result inside handlers."
```

A query that doesn't compile is CS0130; a failed expectation is CS0610. Queries are the only
place a rule sees the syntax tree, so they depend on the grammar version.

## Test and manual rules

```yaml
- id: idempotent
  class: test
  test: { symbol: UserUpdatedHandlerTests.HandleAsync_IsIdempotent, lang: csharp }
- id: dedup-review
  class: manual
  text: Deduplication must use the message id, not the payload hash.
```

A missing test is CS0620. With `catspec check --run-tests`, CatSpec runs `tests.command` from
`catspec.yaml` for each test (no shell; `{test}` is the test name); a failure is CS0621.

## Global rules

Global rules are optional. Without them, everything else in CatSpec works as usual. They live in
the frontmatter of one file, the **architecture spec** (`type: architecture`), and apply to every
source file. CatSpec never reads the text of your decisions, only these rules:

```yaml
---
catspec: 1
id: architecture
type: architecture
status: implemented   # draft = written down but not enforced yet
rules:
  - id: domain-is-pure            # the domain layer never imports infrastructure
    class: structural
    adr: ADR-003                  # optional: the decision this rule enforces
    forbid_import:
      from: "src/domain/**"
      to: ["src/infrastructure/**"]
  - id: no-console                # no console.* calls in shipped code
    class: structural
    forbid_call: "console.*"
    paths: ["src/**"]
  - id: handlers-in-place         # classes named *Handler live in src/handlers/
    class: structural
    naming: { kind: class, name: "*Handler", in_path: "src/handlers/**" }
---
```

Global rules are enforced unless the architecture spec is `draft`; in the hook they run on the
changed files. A rule may name the decision it enforces (`adr: ADR-003`); an id that isn't among
your ADRs is CS0112 (ids compare by number, so ADR-3 and ADR-0003 are the same).

`specs.architecture` in `catspec.yaml` says where your ADRs are: a file, a glob or a folder
(default `docs/architecture/adr/*-adr.md`). Of the files it matches, the one with CatSpec
frontmatter is the architecture spec; more than one is CS0107. The others are plain ADRs: CatSpec
reads only their ids, from the number at the start of the file name (`0007-use-postgres.md` is
ADR-007) or from `ADR-NNN` headings, and never reports errors in them.

### No ADRs yet

`catspec init --with-adr` writes `docs/architecture/adr/<name>-adr.md`, where `<name>` is
`--name` or the name of the folder you ran it in. Its frontmatter has `rules: []`, where the
global rules go; its body is a decision log, one `## ADR-NNN: <title>` section per decision,
starting with ADR-001 "Record architecture decisions". It starts as `draft`: when you add the
first rule, set `status: implemented`.

### ADRs in a folder, one file per decision

Point `specs.architecture` at the folder; `init` does it for you when it finds `docs/adr/`,
`docs/decisions/`, `docs/architecture/decisions/` or another common folder:

```yaml
specs:
  architecture: "docs/adr"
```

Your ADR files stay as they are. Put the global rules in one more file in that folder, with the
frontmatter above; `catspec init --with-adr` writes it as `architecture-rules.md`.

### One file with all your decisions

Point `specs.architecture` at it and put the frontmatter above at its top. Give its decisions
`## ADR-NNN: <title>` headings so that rules can refer to them.

## Waivers

```yaml
waivers:
  - rule: no-console
    reason: "Bootstrap logging before the DI container is built"
    until: 2026-12-31
    paths: ["src/Bootstrap/**"]
```

A waived diagnostic becomes info (CS0400); after `until` the waiver itself is an error (CS0401).
