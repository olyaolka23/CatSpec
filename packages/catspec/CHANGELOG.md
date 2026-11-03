# catspec

## 0.2.0

### Minor Changes

- The ADR file is optional (ADR-028).

  - `catspec check` and the pre-commit hook pass in a repository without an ADR file: there are just
    no repository-wide rules. CS0107 now reports only more than one architecture spec (error) or an
    architecture spec that isn't staged (warning).
  - `specs.architecture` in `catspec.yaml` may be a file, a glob or a folder, e.g. `docs/adr`. Your
    ADR files stay as they are: CatSpec reads only their ids (`0007-use-postgres.md` is ADR-007), so
    rules can name them. The repository-wide rules go in one file with CatSpec frontmatter. ADR ids
    compare by number (ADR-7 = ADR-0007).
  - `catspec init` writes the ADR file only with the new `--with-adr` option, and writes an ADR folder
    it finds (`docs/adr`, `docs/decisions`, …) to `specs.architecture`; with `--with-adr` it puts
    `architecture-rules.md` in that folder.
  - `catspec uninstall --files` never touches your own ADR files.
  - The `AGENTS.md` block no longer names an ADR folder.
  - A `specs:` section with only comments in `catspec.yaml` reads as the defaults.
  - README and user guide: global install (`npm install -g catspec`), what each `init` option is for,
    and what CatSpec reads from an ADR file, with a rules example.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @catspec/lang-typescript@0.2.0
  - @catspec/lang-csharp@0.2.0
  - @catspec/mcp@0.2.0
  - @catspec/cli@0.2.0

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
  - @catspec/lang-typescript@0.1.0
  - @catspec/lang-csharp@0.1.0
  - @catspec/cli@0.1.0
  - @catspec/mcp@0.1.0
