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

- **Status:** Superseded by ADR-014 (deferred to post-MVP) · **Date:** 2026-10-09 · **Ref:** F-10
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

## ADR-013: Large refactorings use an explicit refactor mode and batch rename mapping

- **Status:** Accepted; the refactor-claim part is deferred by ADR-014 · **Date:** 2026-10-09 · **Ref:** spec §11.8
- **Context:** Per-binding rename guessing (ADR-008, spec §11.4) breaks down when a refactor
  renames or moves dozens of bound symbols at once: errors flood the hook, similar classes become
  ambiguous, claimed files block the commit, and re-binding by hand loses the ratchet history.
- **Decision:** `catspec refactor start` takes an exclusive refactor claim and records a baseline.
  `catspec refactor finish` maps every broken binding to its new symbol, preferring exact evidence
  (an explicit rename map, usually written by the agent that did the refactor, then moves, prefix
  rules and git file renames) over similarity scoring. Scoring uses a global one-to-one assignment.
  All location edits and lock-file entries are rewritten in one batch, in the same commit as the
  code. Ambiguous or lost bindings block `finish`, and contract fields are never edited automatically.
  Without `start`, the hook detects a large refactor and reports one grouped diagnostic (`CS0215`).
- **Consequences:** Mass renames cost one command instead of dozens of manual spec edits, and the
  ratchet history survives. The CLI and MCP surface grow (`refactor start|finish|status|abort`,
  `start_refactor`/`finish_refactor`). A refactor claim can make other agents wait.

## ADR-014: Defer claims (agent locks) to after the MVP

- **Status:** Accepted · **Date:** 2026-10-09 · **Supersedes:** ADR-010 · **Amends:** ADR-013
- **Context:** Claims (ADR-010) stop two owners working on the same files at the same time on one
  machine. They don't prevent merge conflicts in general: branches still diverge and are merged
  as usual. Their value shows up mainly when several agents run in parallel, which is not the
  core MVP scenario. They would cost about 1.5 weeks, add concurrency and stale-lock edge cases,
  and can block commits for reasons unrelated to the spec.
- **Decision:** The MVP ships without claims, `assign`/worktree orchestration, claim enforcement
  in the hook, and the MCP `claim_spec`/`release_spec` tools. `refactor start` records only a
  baseline, scope and branch, without an exclusive claim. Codes `CS0500`, `CS0501` and `CS0503`
  are reserved. The `scope` field is still parsed. The ADR-010 design (spec §9) is the plan for
  roadmap 0.4.
- **Consequences:** The MVP is about 1.5 weeks shorter and simpler, and the hook only blocks for
  contract reasons. Parallel agents rely on git branches; conflicts appear at merge time, and
  `catspec check` after the merge catches broken contracts. Coordination before work starts
  arrives with claims later.


## ADR-015: Workflow profiles: CatSpec gates an external SDD workflow instead of owning it

- **Status:** Accepted · **Date:** 2026-10-09 · **Ref:** F-20, spec §17
- **Context:** Teams already plan with OpenSpec, Spec Kit or their own agent skills
  (e.g. `sdd-spec`, `sdd-plan`, `sdd-task`, `sdd-close`). Asking them to switch workflow
  tools to get enforcement blocks adoption.
- **Decision:** `catspec.yaml` gets a `workflow:` profile: a preset (`catspec`, `openspec`,
  `spec-kit`) or `custom` stages, each with a driver (skill, slash command, shell command or
  manual), the artifacts it must produce, entry/exit gates and status transitions. CatSpec
  derives each feature's current stage, tells agents what comes next (`catspec next`, MCP
  `next_step`) and runs the gates (`catspec stage enter|exit`, MCP `enter_stage`/`exit_stage`).
  CatSpec never calls an LLM or runs skills itself. Shell `command` gates run only when
  `workflow.allow_commands: true`, via `execFile` (ADR-009). The current stage is derived,
  never stored (ADR-004).
- **Consequences:** CatSpec works alongside existing SDD tools, and adding it to a custom
  workflow means two lines per skill. Presets for third-party tools must follow their releases
  (pinned preset versions, fixture tests). About one week is added to the MVP (plan M8).

## ADR-016: Consolidated CLI naming

- **Status:** Accepted · **Date:** 2026-10-09 · **Amends:** ADR-013, ADR-014, ADR-015
- **Context:** The planned CLI had overlapping commands and inconsistent verbs (`lint` / `check` /
  `verify`, `sync` / `refactor finish`, `stage enter|exit` vs `refactor start|finish`, and `lock`,
  which sounds like the deferred agent locks).
- **Decision:**
  - `check` is the only validation command: `--specs-only` replaces `lint`, `--spec <id>` replaces `verify`.
  - `sync` is the only command that fixes spec locations. During a refactor it does the batch
    mapping and ends the refactor, which replaces `refactor finish`.
  - `catspec refactor` starts a refactor; `refactor status` and `refactor abort` remain.
  - Workflow stages use `stage start|finish` (MCP `start_stage`/`finish_stage`), and stage config
    uses `start:`/`finish:`.
  - `baseline --rebuild` replaces `lock --rebuild`.
  - MCP `verify_compliance` → `check_compliance`, and `finish_refactor` → `sync_specs`.
  - Gates `lint` → `specs_valid`, `verify` → `contracts_pass`, `adr_lint` → `adr_valid`.
  - Workflow stages get `per: feature|spec` scope and aggregate specs (spec §17.1), so an epic
    can be driven PBI by PBI.
- **Consequences:** Fewer commands to learn, one verb pair for anything that starts and finishes,
  and the old names never ship.

