---
catspec: 1
id: architecture
title: CatSpec architecture
type: architecture
status: implemented      # enforced: `catspec check` runs on this repo in CI (F3)
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
  - id: mcp-gets-adapters-injected
    adr: ADR-024
    class: structural
    forbid_import:
      from: "packages/mcp/src/**"
      to: ["web-tree-sitter", "@catspec/lang", "@catspec/lang-*", "@catspec/cli"]
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
[`docs/spec/reactive-ast-linked-spec-engine/analysis.md`](../../spec/reactive-ast-linked-spec-engine/analysis.md)
(findings `F-n`).

---

## ADR-001: TypeScript on Node.js, npm-workspaces monorepo

- **Status:** Accepted; the Node version is amended by ADR-020 · **Date:** 2026-10-09
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

- **Status:** Accepted; the place of `mcp` is amended by ADR-024 · **Date:** 2026-10-09
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

- **Status:** Accepted; the ADR log location is amended by ADR-017 · **Date:** 2026-10-09
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

## ADR-017: The ADR log moves to `docs/architecture/adr/`

- **Status:** Accepted · **Date:** 2026-10-09 · **Amends:** ADR-012
- **Context:** A separate root `guidelines/` folder split documentation across two top-level
  places. Keeping all documentation under `docs/` is simpler for people and agents to find.
- **Decision:** The ADR log is `docs/architecture/adr/reactive-ast-adr.md`. CatSpec's product
  default becomes `docs/architecture/adr/<name>-adr.md` (config `specs.architecture:
  "docs/architecture/adr/*-adr.md"`). Other project-wide guidelines go in
  `docs/guidelines/<topic>/`. The root `guidelines/` folder is removed.
- **Consequences:** Everything lives under `docs/`: `spec/` (features), `architecture/adr/`
  (decisions and global rules) and `guidelines/` (conventions). Existing links were updated.

## ADR-018: Epic docs: business spec, technical plan with progress, one file per feature

- **Status:** Accepted · **Date:** 2026-10-09 · **Amends:** ADR-012
- **Context:** `tasks.md` had grown to about 1,900 lines and repeated the task lists in `plan.md`,
  while `spec.md` mixed the business idea with the full technical design. Agents had to load
  everything to work on one feature, and progress wasn't visible in one place.
- **Decision:**
  - `spec.md` holds only the **what and why**: problem, goals, users, capabilities, quality
    requirements and acceptance scenarios.
  - `plan.md` holds the **how**. Part I (delivery) has the principles, a **Progress** checklist
    with one checkbox per feature (ticked only with the owner's approval), the feature order and
    the working rules (Gherkin, Definition of Done, enforcement). Part II is the technical design.
  - Each feature of an epic has its own file `features/<feature-id>.md` with its description,
    requirements, Gherkin acceptance criteria, Definition of Done, PBIs and tasks.
  - `tasks.md` remains only for small epics without `features/`.
  - Section numbers of the technical design are kept with a `D` prefix. "spec §3–§14" and
    "spec §17" in earlier ADRs now mean plan §D3–§D14 and §D17; spec §15 and §16 are now spec §4
    and §5.
  - CatSpec's product default layout (plan §D3) is unchanged by this decision.
- **Consequences:** An agent working on one feature reads `spec.md`, the parts of `plan.md` it
  needs, and one feature file. Progress is visible in `plan.md` §1. The acceptance-coverage
  check reads tags from `features/*.md`.

## ADR-019: Runtime dependencies of `@catspec/core` and `@catspec/cli`

- **Status:** Accepted; the `commander` version is amended by ADR-020 · **Date:** 2026-10-10 · **Ref:** plan §D11.1, PBI `cli-skeleton`
- **Context:** Plan §D11.1 lists `yaml`, `zod`, `remark-parse` and `picomatch` for core.
  `remark-parse` is a unified plugin and needs `unified` to run. The CLI needs an argument
  parser (`commander` in PBI `cli-skeleton`).
- **Decision:** `@catspec/core` depends on `yaml`, `zod` (v4), `remark-parse` with `unified`
  (already a dependency of `remark-parse`, so nothing extra is installed) and `picomatch`.
  `@catspec/cli` depends on `commander` v14 (v15 requires Node ≥ 22.12, and we support Node 20).
  New runtime dependencies need a new ADR.
- **Consequences:** No native modules; the dependency list is the one in §D11.1 plus `unified`
  and `commander`.

## ADR-020: Node.js 22.12 or newer

- **Status:** Accepted · **Date:** 2026-10-10 · **Amends:** ADR-001, ADR-019
- **Context:** ADR-001 set Node ≥ 20. Node 20 reached end of life on 2026-04-30 and no longer
  gets security fixes; the supported lines are Node 22 (until April 2027) and Node 24. Keeping
  Node 20 also held back dependencies: `commander` 15 needs Node ≥ 22.12 (ADR-019).
- **Decision:** CatSpec requires Node ≥ 22.12 (the `engines` field of every package); 22.12 is
  the first Node 22 release that loads ES modules with `require`, which `commander` 15 relies on.
  CI tests Node 22 and 24, builds target Node 22, and the CLI uses `commander` 15.
- **Consequences:** Users on Node 20 upgrade Node before installing CatSpec. Dropping a Node
  line later needs a new ADR.

## ADR-021: Tree-sitter runtime and grammar WASM

- **Status:** Accepted · **Date:** 2026-10-11 · **Ref:** ADR-002, plan §D11.1, PBI `tree-sitter-runtime`
- **Context:** ADR-002 chooses `web-tree-sitter` with pinned grammar WASM files, and ADR-019
  requires an ADR for each new runtime dependency. `scripts/build-grammars` doesn't exist yet;
  plan §4 (Risks) names the prebuilt `tree-sitter-wasms` package as the interim grammar source.
- **Decision:** `@catspec/lang` depends on `web-tree-sitter`, pinned to an exact version checked
  to load the grammars (0.25.10; later releases can't load the `tree-sitter-wasms` builds).
  `tree-sitter-wasms@0.1.13` is a pinned devDependency of `@catspec/lang-typescript`; its build
  copies only `tree-sitter-typescript.wasm` and `tree-sitter-tsx.wasm` into the published package.
- **Consequences:** No native builds, and the adapter package stays small. Replacing the interim
  grammars with our own build needs a new ADR.

## ADR-022: Query rules run through optional adapter methods

- **Status:** Accepted · **Date:** 2026-10-14 · **Refines:** ADR-003 · **Ref:** plan §D6.3, §D11.2, PBI `query-and-test-rules`
- **Context:** ADR-003 keeps syntax trees out of `@catspec/core`: rules read `FileFacts`, and only
  `query` rules see raw trees, "via the adapter". The `LanguageAdapter` interface in plan §D11.2
  has no method for that, and a `query` rule's Tree-sitter query must be compiled when the specs
  load (CS0130), before any code is parsed.
- **Decision:** `LanguageAdapter` gets two optional methods. `checkQuery(query)` compiles a query
  and returns the error message, or undefined when it compiles. `runQuery(file, query)` returns
  the ranges of the `@hit` captures, or of each match's first capture when the query has no
  `@hit`. Core calls only these; it never imports Tree-sitter. An adapter without them doesn't
  support `query` rules, which is reported as CS0130. Each `query` rule names its language
  (`lang`, required), so a query is compiled and run only by that language's adapter.
- **Consequences:** Core stays free of Tree-sitter, and adding a language with query support
  means implementing two methods. Queries are compiled once per grammar and cached. The
  `core-public-api` spec binds both methods as optional members of `LanguageAdapter`.

## ADR-023: C# grammar WASM

- **Status:** Accepted · **Date:** 2026-10-15 · **Ref:** ADR-002, ADR-021, PBI `csharp-declarations`
- **Context:** ADR-021 takes the TypeScript grammars from the pinned `tree-sitter-wasms@0.1.13`.
  Its C# build (tree-sitter-c-sharp 0.20) can't parse C# 12 primary constructors, which F4 requires.
- **Decision:** `tree-sitter-c-sharp@0.23.5`, which ships its own WASM build, is a pinned
  devDependency of `@catspec/lang-csharp`. Its build copies only `tree-sitter-c_sharp.wasm` into
  the published package. The build was checked to load in `web-tree-sitter` 0.25.10 (ADR-021).
- **Consequences:** No native builds. Upgrading the C# grammar is a change to that pin and the
  adapter version. Replacing it with our own build needs a new ADR.

## ADR-024: MCP server on the MCP SDK v2; `cli` serves it and injects the engine

- **Status:** Accepted · **Date:** 2026-10-21 · **Amends:** ADR-003 · **Ref:** ADR-019, plan §D14, PBI `mcp-server-core`
- **Context:** F7 adds `catspec mcp`. ADR-019 requires an ADR for each new runtime dependency.
  Plan §D14 names `@modelcontextprotocol/sdk`; its v2 successor `@modelcontextprotocol/server`
  pulls in only `@modelcontextprotocol/core` and `zod` (v1 pulls in express, hono, jose and cors)
  and serves both 2025-era clients and the current protocol. ADR-003 has `cli` and `mcp` each
  inject the adapters, but the git side of `sync` and `refactor` (F6) lives in `cli`, and
  `catspec mcp` is a `cli` command.
- **Decision:** `@catspec/mcp` depends on `@catspec/core`, `@modelcontextprotocol/server` (v2)
  and `zod` (v4) only. `@catspec/cli` depends on `@catspec/mcp`: `catspec mcp` creates the server
  and injects an `Engine` (adapters, codebase loading, the git side of `sync` and `refactor`, diff
  and graph output). `@modelcontextprotocol/client` is a devDependency, for tests only.
- **Consequences:** The MCP server reuses the CLI's code instead of duplicating it, and stays free
  of Tree-sitter and the adapters. Enforced by the rule `mcp-gets-adapters-injected` above and by
  `test/monorepo.test.ts`. Changing the MCP SDK's major version needs a new ADR.

## ADR-025: `workflow.feature_dir` may list several folder patterns

- **Status:** Accepted · **Date:** 2026-10-26 · **Ref:** plan §D17.2, ADR-015
- **Context:** Repositories often split specs by domain: features live both in
  `docs/spec/<feature>` and in domain folders such as `docs/spec/billing/<feature>`. One
  `feature_dir` pattern can't describe that: `docs/spec/{feature}` makes `billing` a feature.
- **Decision:** `workflow.feature_dir` is a pattern or a list of patterns, each with `{feature}`
  exactly once. A path belongs to the most specific matching pattern (more folders, then longer).
  A folder that holds another pattern's features (`docs/spec/billing`) is never a feature. The
  default `specs.include` and the CS0106 layout check follow every pattern. A single string keeps
  its meaning.
- **Consequences:** Domain-split repositories need no `layout: free`. Two features with the same
  name in different domain folders are one feature to `catspec next` and `stage` (the first one
  found); give them distinct names. `catspec workflow show --format json` adds `featureDirs`.

## ADR-026: `catspec uninstall`, and a pre-commit hook that never blocks without CatSpec

- **Status:** Accepted · **Date:** 2026-10-26 · **Ref:** plan §D13, §D14.3
- **Context:** After the package was removed from a project, the pre-commit hook still ran
  `npx --no-install catspec`, which asked the registry, failed, and blocked every commit. The
  files `init` wrote had to be found and removed by hand.
- **Decision:** The hook runs `node_modules/.bin/catspec`, else a `catspec` on the PATH, else it
  lets the commit through and prints that CatSpec isn't installed. `catspec uninstall` removes
  the pre-commit hook, the Claude Code `Stop` hook and the `AGENTS.md` block, keeping all other
  content byte for byte; `--files` also deletes `catspec.yaml`, the local cache, and the example
  feature and ADR log while they are as `init` wrote them. Specs, lock files and edited files are
  never deleted; they are listed as kept.
- **Consequences:** Removing CatSpec is one command, run before `npm uninstall catspec`. A
  repository whose hook can't find CatSpec is no longer protected, and each commit says so.

## ADR-027: The user guide ships with the CLI and is served to agents

- **Status:** Accepted · **Date:** 2026-10-26 · **Ref:** plan §D14, ADR-024
- **Context:** People and agents need the user guide while they work, but it lives only in the
  repository. An agent can't open a link to a private repository, and a link shows the guide of
  `main`, not of the installed version.
- **Decision:** The build copies `docs/spec/catspec-user-guide/*.md` (without the guide's own
  `spec.md`) into the published `guide/` folder of `@catspec/cli`. `catspec guide` lists the
  pages and `catspec guide <page>` prints one. The CLI passes the pages to the MCP server
  (`WorkspaceOptions.guide`, injected as in ADR-024), which serves the tool `read_guide` and the
  resources `catspec://guide/{page}`, and names `read_guide` in its instructions. Links that leave
  the guide folder are rewritten to the repository on GitHub. The `AGENTS.md` block names
  `catspec guide` and `read_guide`.
- **Consequences:** Every installed version answers from its own guide, offline; the package
  grows by about 65 KB. Page names are now public: renaming a page changes `catspec guide <page>`
  and its resource URI.
