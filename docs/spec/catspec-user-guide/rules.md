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

## Waivers

```yaml
waivers:
  - rule: no-console
    reason: "Bootstrap logging before the DI container is built"
    until: 2026-12-31
    paths: ["src/Bootstrap/**"]
```

A waived diagnostic becomes info (CS0400); after `until` the waiver itself is an error (CS0401).
