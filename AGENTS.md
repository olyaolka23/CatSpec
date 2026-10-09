# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, Windsurf…)
and humans working in this repository.

## Documentation & specs location (mandatory)

All documentation and specifications live under **`docs/spec/<feature>/`**.

```
docs/spec/
  <feature>/              # one folder per feature, kebab-case, e.g. mcp-server, git-hooks
    01-analysis.md        # requirements analysis / problem statement (optional)
    02-spec.md            # specification: what and why
    03-plan.md            # implementation plan: how and in what order
    tasks.md              # task breakdown / checklist (optional)
    *.spec.md             # machine-checkable CatSpec specs for this feature (optional)
    adr/NNNN-<title>.md   # decisions specific to this feature (optional)
    examples/             # transcripts, sample inputs/outputs (optional)
  project/                # cross-cutting docs that belong to no single feature
    adr/                  # project-wide architecture decision records
    guides/               # user-facing guides, references, FAQ
```

Rules:

1. **Before starting work on a feature**, look for `docs/spec/<feature>/` and read its
   spec and plan. If none exists and the change is more than a small fix, create the
   folder and write the spec (and plan) **before** writing code.
2. **Never create docs or specs anywhere else**: no root-level `*.md` design notes, no
   `docs/<file>.md` outside `docs/spec/`, no `specs/`, `.specs/` or `design/` folders,
   no docs next to source code.
3. **One feature, one folder.** Folder names are kebab-case and stable; don't rename a
   folder without updating every link to it. Use the existing folder when extending a feature.
4. **Keep spec and code in sync in the same change.** If code changes behaviour that a
   spec describes, update the spec in the same commit/PR.
5. Cross-cutting material (repo-wide conventions, ADRs that affect several features,
   user guides) goes to `docs/spec/project/`.
6. Use relative links between docs; files inside one feature folder link as `./02-spec.md`.

Exceptions: the standard root files `README.md`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`,
`CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and GitHub
templates in `.github/`, stay where tools expect them.

Current features:

| Feature | Folder |
|---|---|
| CatSpec MVP: analysis, spec, plan | [`docs/spec/catspec-mvp/`](docs/spec/catspec-mvp/) |
