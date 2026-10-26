# Rule catalogue

Rules are invariants beyond a binding's shape. They live under `rules:` in a spec, or in the ADR
log's frontmatter for rules over the whole repository. The full design is in
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

The ADR log, `docs/architecture/adr/<name>-adr.md` (`type: architecture`), holds the rules that
apply to the whole repository in its frontmatter and the decisions in its body (`## ADR-NNN:`
sections). Give each rule the decision it enforces (`adr: ADR-003`); an unknown id is CS0112.
Global rules are always enforced unless the log is `draft`; in the hook they run on the changed
files.

### The ADR log that `init` writes

`catspec init` writes `docs/architecture/adr/<name>-adr.md`, where `<name>` is `--name` or the
name of the folder you ran it in. It is the one architecture spec of the repository:

- its frontmatter has `type: architecture` and `rules: []`, where the repository-wide rules go;
- its body is the decision log, one `## ADR-NNN: <title>` section per decision, starting with
  ADR-001 "Record architecture decisions".

It starts as `draft`, so its rules aren't enforced yet. When you add the first rule, set
`status: implemented` (any status but `draft` enforces them). You can rename the file, as long as
it stays in `docs/architecture/adr/` and its name ends in `-adr.md`.

### If you already have ADRs

CatSpec reads exactly one ADR log: the file that matches `specs.architecture` in `catspec.yaml`
(default `docs/architecture/adr/*-adr.md`). What to change depends on what you have.

- **One file per decision** (`docs/architecture/adr/0007-use-postgres.md`, …): keep them and let
  `init` add its log next to them. For rules to refer to those decisions, list them in the log as
  headings that start with their id. A link in the heading is fine:

  ```markdown
  ## [ADR-007: Use Postgres](./0007-use-postgres.md)
  ```

  None of your files may end in `-adr.md`, or CatSpec sees two logs (CS0107). If one does, set
  `specs.architecture` to the exact path of the log, e.g. `docs/architecture/adr/shop-adr.md`.

- **One file with all your decisions**: make it the log. Point `specs.architecture` at it, put
  the frontmatter below at its top, and delete the log `init` wrote. Give its decisions
  `## ADR-NNN: <title>` headings so that rules can refer to them.

  ```yaml
  ---
  catspec: 1
  id: architecture
  type: architecture
  status: implemented
  rules: []
  ---
  ```

- **A file whose name ends in `-adr.md` but has no CatSpec frontmatter**: `init` takes it for the
  log and doesn't write one, and `check` reports CS0101. Put the frontmatter above at its top, or
  rename it and run `init` again.

Keep your own numbers as the ids. If you already have an ADR-001, renumber or delete the starter
decision that `init` wrote, so that one id means one decision.

## Waivers

```yaml
waivers:
  - rule: no-console
    reason: "Bootstrap logging before the DI container is built"
    until: 2026-12-31
    paths: ["src/Bootstrap/**"]
```

A waived diagnostic becomes info (CS0400); after `until` the waiver itself is an error (CS0401).
