# FAQ and known limits

## Known limits of 0.1

- **Structure, not behaviour.** CatSpec checks names, members, signatures, base types, attributes,
  imports and calls. Behaviour ("must be idempotent") needs a `test` rule, or stays a tracked
  `manual` rule.
- **Syntax only.** CatSpec reads each file's syntax tree (Tree-sitter); it doesn't compile or
  resolve types across files. Inheritance chains, type aliases and re-exports aren't followed, and
  an overloaded C# method can't be bound (CS0202). When something can't be decided, CatSpec says
  so (CS0220) instead of guessing.
- **Two languages:** TypeScript (`.ts`, `.tsx`) and C# (`.cs`).
- **Files over 1 MiB aren't parsed.** They get one CS0901 warning and no facts. A file with syntax
  errors still gives the declarations around the errors, plus CS0901 at each error.
- **No locks between agents.** Parallel agents work on separate branches; `catspec check` after a
  merge catches broken contracts. Claims are planned after 0.1 (ADR-014).
- **Local only.** No SARIF output, PR comments or GitHub App yet.
- **No network, no code execution** except `check --run-tests` with your `tests.command`, and
  `command:` gates when `workflow.allow_commands: true`.

## Questions

**Why did my renamed method fail the commit?** The spec still names the old method. Run
`catspec sync`; if it found the rename, `catspec sync --apply` updates the spec. If the new name is
what you want in the contract, edit the spec.

**I changed a signature on purpose; how do I stop the drift warning?** `catspec accept <spec-id>`
records the new shape in the lock file.

**Can I commit without the check?** `git commit --no-verify`, or `CATSPEC_SKIP=1 git commit`, which
the next run reports as a warning.

**Why is a missing member only a warning?** The spec is `in-progress`: unfinished parts warn until
they have passed once. `catspec check --spec <id>` shows what's left, as if implemented.

**Why does `catspec status <id> in-progress` refuse?** A dependency isn't implemented and passing
(CS0502). `--force` skips that check, never the contract check for `implemented`.

**How fast is it?** On the 10,000-file benchmark repository: the staged check of a commit within
1.1 seconds with a warm cache, a full check within 10.5 seconds with an empty one (CI checks both
on Linux, macOS and Windows). Parsed files are cached by content in
`<git-common-dir>/catspec/cache/`.

**Where are the lock files, and can I delete them?** `<spec-id>.lock.json` next to each spec. Commit
them. `catspec baseline --rebuild` recreates them, but loses the ratchet history (what passed
before).
