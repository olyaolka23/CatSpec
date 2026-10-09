---
catspec: 1
id: architecture
title: CatSpec architecture
type: architecture
status: draft            # becomes enforced once CatSpec can check itself (plan M3)
rules:
  - id: core-has-no-parser-dependency
    adr: ADR-003
    class: structural
    forbid_import:
      from: "packages/core/**"
      to: ["web-tree-sitter", "@catspec/lang", "@catspec/lang-*", "@catspec/cli", "@catspec/mcp"]
  - id: lang-does-not-know-frontends
    adr: ADR-003
    class: structural
    forbid_import:
      from: "packages/lang*/**"
      to: ["@catspec/cli", "@catspec/mcp"]
  - id: no-shell-in-git-access
    adr: ADR-009
    class: structural
    forbid_call: "child_process.exec"
    paths: ["packages/core/src/git/**"]
---

# Architecture Decision Records

This file is the architecture spec of the repository:

- the **frontmatter** holds the global rules that CatSpec checks over the whole codebase;
- the **body** is the decision log: one `## ADR-NNN` section per decision.

How to add a decision (see `AGENTS.md`):

1. Append a new section with the next number. Never renumber or delete entries.
2. To change an accepted decision, add a new ADR that **supersedes** it, and set the old
   one's status to `Superseded by ADR-NNN`.
3. If the decision can be checked in code, add a rule to the frontmatter with `adr: ADR-NNN`.

Format: **Status** · **Date** · **Context** · **Decision** · **Consequences**. Detailed
reasoning for ADR-002…ADR-012 is in
[`docs/spec/reactive-ast-linked-spec-engine/analysis.md`](../../docs/spec/reactive-ast-linked-spec-engine/analysis.md)
(findings `F-n`).

---

## ADR-001: TypeScript on Node.js, npm-workspaces monorepo

- **Status:** Accepted · **Date:** 2026-10-09
- **Context:** The MCP SDK is first-class in TypeScript; target users install via `npx`.
- **Decision:** TypeScript (strict, ESM), Node ≥ 20, npm workspaces: `core`, `lang`,
  `lang-typescript`, `lang-csharp`, `cli`, `mcp`, plus the `catspec` meta-package.
- **Consequences:** One toolchain for CLI, MCP and adapters. Heavy semantic analysis (Roslyn)
  can only come in later as an external backend.

## ADR-002: Tree-sitter via WASM, syntactic matching with normalisation

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-5, F-16
- **Context:** We need multi-language parsing without compiling the user's project or native builds.
- **Decision:** `web-tree-sitter` with pinned grammar WASM files. Type references are
  normalised and matched by qualified-name suffix. Anything that can't be decided from
  syntax alone gets an `unresolvable` diagnostic, never a false error.
- **Consequences:** Works everywhere `npx` works. No inheritance chains or alias resolution in the MVP.

## ADR-003: Rules operate on normalised facts; dependency direction `core ← lang ← lang-* ← cli/mcp`

- **Status:** Accepted · **Date:** 2026-10-09
- **Context:** The rule engine must be language-agnostic and testable without grammars.
- **Decision:** Adapters convert syntax trees into `FileFacts`. `core` defines the
  `LanguageAdapter` and `FileFacts` types and never imports Tree-sitter or any adapter.
  `cli` and `mcp` inject the adapters. Only `query` rules see raw trees, via the adapter.
- **Consequences:** Adding a language means adding an adapter only. Enforced by the frontmatter rules above.

## ADR-004: Three state stores: declared, observed, runtime

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-1
- **Decision:** Human intent goes in `*.spec.md` frontmatter. Machine-observed facts go in a
  generated `<spec-id>.lock.json` next to its spec (committed). Ephemeral state (claims,
  cache) goes in `<git-common-dir>/catspec/` (never committed).
- **Consequences:** No locks in git history, no merge conflicts over runtime state, and all
  worktrees share one claim table.

## ADR-005: Symbol-first bindings

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-6
- **Decision:** A binding is identified by its (qualified) symbol. `file` is only a hint (path or glob).
- **Consequences:** Moving a file doesn't break specs. Repo-wide symbol search is needed (lazy, cached).

## ADR-006: Status-aware enforcement with a ratchet

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-4
- **Decision:** `draft`/`ready` specs are not enforced. In `in-progress` specs, unmet
  contracts are warnings, but a contract that already passed once (recorded in the lock
  file) is an error. `implemented` specs are fully enforced.
- **Consequences:** The hook doesn't block work in progress but does block regressions.

## ADR-007: Invariant classes: structural, query, test, manual

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-2, F-3
- **Decision:** Only machine-checkable classes can block. `manual` invariants are tracked
  and reported as "unenforced". Prose bullets reference rule ids.
- **Consequences:** "Executable spec" becomes a measurable ratio, and the gate stays deterministic.

## ADR-008: Spec edits only through a YAML CST; automatic edits limited to location fields

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-7, F-13
- **Decision:** All writes use the `yaml` Document API and preserve comments and the body
  byte for byte. Auto-heal and MCP may change `symbol`/`file` only. Contract edits require a
  human, or `mcp.allow_contract_edits: true`.
- **Consequences:** Agents can't weaken the contract they are checked against. Diffs stay reviewable.

## ADR-009: The pre-commit hook reads the git index, not the working tree; git is called without a shell

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-9
- **Decision:** `--staged` mode reads every file through `git cat-file --batch`. Git is
  invoked with `execFile`, never through a shell.
- **Consequences:** Partially staged files are checked correctly, and there's no shell-injection surface.

## ADR-010: Local claims with O_EXCL leases in the git common dir, enforced at commit

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-10
- **Decision:** Claims are atomic lease files with TTL and heartbeat. Overlapping scopes
  are refused. The pre-commit hook rejects commits into another owner's claim. A
  `ClaimStore` interface allows a git-refs backend later.
- **Consequences:** Safe parallel agents on one machine. Coordination across machines is post-MVP.

## ADR-011: Stable diagnostic codes as the public contract

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-14
- **Decision:** Every check emits a `CSxxxx` code with expected/actual/suggestions. Codes
  are never reused, and their meaning never changes.
- **Consequences:** Agents, CI and IDE integrations can rely on the codes, and the docs are generated from the registry.

## ADR-012: Documentation layout: feature folders and a single ADR log

- **Status:** Accepted · **Date:** 2026-10-09
- **Context:** Spec-driven development needs every agent to find a feature's docs and the
  project's architecture decisions in a predictable place.
- **Decision:** Each feature's docs live in `docs/spec/<feature>/` (kebab-case full epic name)
  with fixed file names `analysis.md`, `spec.md`, `plan.md`, `tasks.md`, and its `*.spec.md`
  machine specs. Architecture decisions and global rules live only in
  `guidelines/architecture/reactive-ast-adr.md` (product default: `guidelines/architecture/<name>-adr.md`, where `<name>` is the project or epic name in kebab-case). This is both this repo's convention (`AGENTS.md`) and
  CatSpec's product default (`catspec init`, lint `CS0106`).
- **Consequences:** No numbered or scattered design docs. The architecture spec is discovered at a fixed path.
