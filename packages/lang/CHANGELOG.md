# @catspec/lang

## 0.2.1

### Patch Changes

- cbc80c8: Add npm keywords to every package, so CatSpec shows up in npm search.
- Updated dependencies [cbc80c8]
  - @catspec/core@0.2.1

## 0.2.0

### Minor Changes

- Released with `@catspec/core` 0.2.0, so that every CatSpec package has the same version. No changes of its own.

### Patch Changes

- Updated dependencies
  - @catspec/core@0.2.0

## 0.1.0

### Minor Changes

- 5d98dc8: CatSpec 0.1.0: specs bound to code, for TypeScript and C#.

  - `catspec check` checks Markdown specs (`*.spec.md`) against the code: bindings, members,
    signatures, base types, attributes, constructor dependencies, structural and query rules, and
    repository-wide rules from the ADR log. Statuses decide how strictly (ratchet, drift).
  - The pre-commit hook (`catspec install-hooks`) checks what is being committed and keeps the
    lock files; `catspec sync` heals renames and moves, `catspec refactor` handles large ones.
  - AI agents: `catspec mcp` (MCP server), the `AGENTS.md` block and the Claude Code Stop hook
    (`catspec init --agents`).
  - Workflows: `catspec`, `openspec`, `spec-kit` and `custom` presets with `catspec next`,
    `catspec stage start|finish` and `catspec workflow doctor`.
  - User guide: `docs/spec/catspec-user-guide/` in the repository.

  Known limits:

  - Structure, not behaviour: behaviour needs a `test` rule or stays a `manual` rule.
  - Syntax only (Tree-sitter): no type resolution across files; inheritance chains, aliases and
    re-exports aren't followed; overloaded C# methods can't be bound (CS0202).
  - TypeScript and C# only. Files over 1 MiB aren't parsed (CS0901).
  - No locks between parallel agents (post-0.1, ADR-014); no SARIF, PR comments or GitHub App yet.
  - Speed on the 10,000-file benchmark: staged check within 1.1 s warm, full check within 10.5 s cold (13 s on Windows).

### Patch Changes

- Updated dependencies [5d98dc8]
  - @catspec/core@0.1.0
