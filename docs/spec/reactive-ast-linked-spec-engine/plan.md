# CatSpec — Implementation Plan (MVP v0.1)

> Implements [`spec.md`](./spec.md). Finding references `F-n` point to
> [`analysis.md`](./analysis.md). Estimates assume one experienced
> TypeScript engineer; parallelisable work is marked ⇄.
> The step-by-step breakdown into features, PBIs and tasks is in [`tasks.md`](./tasks.md).

## 0. Principles

- **Vertical slices early.** By the end of M3 one language works end-to-end
  (spec → check → diagnostics); everything after adds depth.
- **Facts, not trees.** Adapters turn Tree-sitter trees into `FileFacts`; the rule
  engine never sees grammar nodes. Rules are tested with hand-written facts, adapters with golden files.
- **Dogfooding.** From M3 the CatSpec repo has its own machine specs in `docs/spec/<feature>/` (see `AGENTS.md`) describing its
  packages (TypeScript adapter), and `catspec check` runs in the repo's own CI.
- **Every milestone ends releasable** (`0.0.x` pre-releases on npm under `next`).

## 1. Milestones overview

| # | Milestone | Weeks | Delivers spec § | Exit criterion |
|---|---|---|---|---|
| M0 | Repo scaffolding | 0.5 | 11.1 | CI green on empty packages |
| M1 | Spec model, spec validation, DAG | 1.5 | 4, 5, 6 (parse), 8, 10 (`init/check --specs-only/list/show/graph`) | `catspec check --specs-only` on fixture specs, CST round-trip identity |
| M2 | Language layer + TypeScript adapter | 1.5 | 11.2, 11.7 (cache) | golden facts for TS fixtures |
| M3 | Rule engine & `check` (working tree) | 1.5 | 6, 11.3, 11.5, 12, 10 (`check [--spec]/coverage/status`) | acceptance 1, 6, 7 on TS |
| M4 | C# adapter ⇄ | 1.5 | 5.3 partial classes, attributes, DI | acceptance 1, 6 on C# fixtures |
| M5 | Git: staged reading, hook, lock file, ratchet, drift | 1.5 | 7, 8, 13, 11.3 IndexProvider | acceptance 4, 5 |
| M6 | Rename/move detection, heal, large refactors | 1.5 | 11.4, 11.6, 11.8, `sync/accept/bind/refactor` | acceptance 2, 3, 11, 12 |
| M7 | MCP server & agent layer | 1 | 14 | acceptance 9, 10, 17; works in Claude Code |
| M8 | Workflow profiles (custom skills, OpenSpec, Spec Kit) | 1 | 17 | acceptance 14, 15, 16 |
| M9 | Hardening & 0.1.0 release | 1 | 15 | all MVP acceptance scenarios (1–7, 9–12, 14–17), perf budgets, docs |
| | **Total** | **~12.5** (≈11 with M4 parallel) | | |

Critical path: M0 → M1 → M2 → M3 → M5 → M6 → M7 → M8 → M9. M4 can run in parallel
with M5–M6 if a second person is available. M8 was previously claims, `assign` and worktree
orchestration; those were deferred to post-MVP (ADR-014, roadmap 0.4), and M8 is now workflow profiles.

---

## M0 — Scaffolding (0.5 w)

Tasks
1. npm workspaces monorepo: `packages/{core,lang,lang-typescript,lang-csharp,cli,mcp,catspec}`.
2. TypeScript 5 strict, ESM, `tsup` builds, `vitest`, `eslint` + `prettier`, `changesets` for versioning.
3. GitHub Actions for **this repo** (lint, typecheck, test on Linux/macOS/Windows, Node 20/22).
4. `fixtures/` directory convention: `fixtures/<name>/{repo files, catspec.yaml, docs/spec/<feature>/, docs/architecture/adr/<name>-adr.md, expected.json}`.
5. CONTRIBUTING, issue templates, keep `docs/architecture/adr/reactive-ast-adr.md` up to date (decisions F-1…F-19 are already logged there as ADR-001…).

Done when: `npm test` and CI pass with placeholder tests on 3 OSes.

---

## M1 — Spec model, spec validation, DAG (1.5 w)

Tasks
1. **Config** (`core/config`): zod schema for `catspec.yaml`, defaults, discovery of root `catspec.yaml` (walk up to git root), JSON Schema export (`zod-to-json-schema`) into `schemas/`.
2. **Frontmatter parser** (`core/spec/parse`): split `---` block with exact offsets; parse with `yaml` `parseDocument` (keep CST + line positions for diagnostics).
3. **Spec schema** (`core/spec/schema`): zod for §5.2–5.3, §6; shorthand normalisation (`members: ["login"]` → member objects); position mapping from zod issue path → YAML node range → `specLocation`.
4. **Body parser** (`core/spec/body`): remark → extract `[rule:id]`/`[binding:id]` refs, `Contracts`/`Invariants` bullets, task checkboxes.
5. **Repo loader**: glob discovery, duplicate id detection, `SpecSet` with indexes (id → spec, file → specs placeholder).
6. **DAG** (`core/graph`): build, Tarjan SCC for cycles (report full cycle path), unknown deps, topological order, `ready` computation (status-only for now).
7. **CST editor** (`core/spec/edit`): `applyPatch(spec, ops)` via `Document.setIn/deleteIn`; byte-for-byte preservation of body; golden round-trip suite (comments, quotes, flow vs block sequences, CRLF).
8. **Diagnostics core**: `Diagnostic` type, code registry (code → default severity, docs URL), text + json reporters.
9. **CLI skeleton** (`commander`): global flags, exit codes, `init` (feature-folder layout, starter `<name>-adr.md`, `--agents` writes layout rules to `AGENTS.md`), `check --specs-only` (incl. CS0106 layout and CS0112 ADR-id checks), `list`, `show`, `graph --format mermaid|dot|json`.

Tests: schema unit tests per field; ~20 fixture specs (valid/invalid); DAG cycle cases; CST round-trip property test (fast-check: random edits on random valid docs keep the body untouched and re-parse equal).

Done when: `catspec check --specs-only` reports CS01xx with correct line numbers on fixtures; `init` creates a working layout; round-trip identity holds.

---

## M2 — Language layer + TypeScript adapter (1.5 w)

Tasks
1. **WASM loader** (`lang/runtime`): `web-tree-sitter` init once, grammar loading from package-relative path, version pinning; grammar files vendored per adapter package (built from pinned `tree-sitter-typescript` release; build script in `scripts/build-grammars`).
2. **Adapter interface & registry** (§11.2), language resolution by extension + config include/exclude.
3. **Query runner**: compile `.scm` queries once per language; helper to iterate captures into typed facts.
4. **TypeScript adapter**:
   - declarations: class, interface, type alias, enum, function, exported const arrow functions, methods, properties, constructor params (incl. parameter properties `constructor(private log: ILogger)`), getters/setters, overload signatures;
   - modifiers, decorators (name + args text), `export`/`export default`, `implements`/`extends` lists, generics;
   - imports (static, `import type`, dynamic `import()` literal, `require` literal), re-export lines recorded but not resolved;
   - calls: callee text (`a.b.c`), enclosing symbol;
   - qualified name: `relative/path#Outer.Inner`;
   - type normalisation: whitespace, union order kept, `Array<T>` ≡ `T[]`, strip `readonly` from params.
5. **Normaliser utilities** shared by adapters: suffix matching on qualified names and generic type refs (parse `A.B<C.D, E>` into a tree, compare segment-wise).
6. **Parse cache**: blob SHA via `git hash-object` (batched `--stdin-paths`) or computed in-process (`sha1("blob <len>\0" + content)`), cache dir under git common dir, versioned key; fallback to in-memory when not a git repo.
7. **Symbol index**: lazy repo-wide index (name → symbol ids) built from cached facts.

Tests: golden `FileFacts` JSON for ~25 TS fixtures (one feature each); snapshot updates via `vitest -u` reviewed in PRs; parse-error fixture yields partial facts.

Done when: `catspec show-facts <file>` (hidden debug command) prints correct facts for all fixtures; cache hit path skips parsing (measured).

---

## M3 — Rule engine & `check` (1.5 w)

Tasks
1. **Binding resolver** (§11.5) incl. did-you-mean (Damerau-Levenshtein, same kind, same file first).
2. **Contract evaluator**: kind, exported/visibility, implements/extends (normalised suffix), attributes, members (existence, kind, params positional with `*`, returns, modifiers, optional), `constructor.requires`. Each check emits its own item id (`binding:handler.HandleAsync`) — needed later for the ratchet.
3. **Structural rules**: `forbid_call`, `require_call`, `forbid_import`, `allow_import_only`, `naming`, `must_not_exist`; `within` scoping by binding/member ranges.
4. **`query` rules**: compile per language when specs are loaded, run on scoped files, `expect: absent|present`.
5. **`test` rules**: resolve test symbol (existence). `--run-tests`: run `config.tests.command` with `{symbol}` placeholder; map exit code → CS0621. (Simple, opt-in.)
6. **`manual` rules** and prose: counted in coverage, CS0111 for unreferenced prose.
7. **Architecture spec**: global scope evaluation.
8. **Status matrix** (§8) without ratchet (lock file comes in M5); waivers + expiry.
9. **Commands**: `check [paths] [--spec <id>] [--specs-only]` (with `--spec`: agent-oriented text, expected/found/fix per item, ends with `DONE` / `NOT DONE`), `coverage`.
10. Promote `status` command: `implemented` only if `check --spec` passes; `in-progress` only if deps satisfied (§8).
11. **Dogfood**: add `*.spec.md` files under `docs/spec/<feature>/` (config `specs.include: ["docs/spec/**/*.spec.md"]`) describing `core` public API (e.g. `LanguageAdapter` interface members) and run `catspec check` in CI.

Tests: rule engine unit tests on synthetic `FileFacts` (no grammar); end-to-end fixture repos for acceptance 1 & 6 (TS); message wording snapshot tests (diagnostics are UX).

Done when: acceptance scenarios 1, 6 and 7 pass on TS fixtures; dogfood check runs in CI.

---

## M4 — C# adapter (1.5 w, ⇄ parallel with M5–M6)

Tasks
1. Grammar `tree-sitter-c-sharp` (pinned) → WASM.
2. Declarations: namespace (block + file-scoped), class/struct/record/interface/enum, nested types, methods, properties, fields, events, constructors (incl. primary constructors C# 12), operators skipped.
3. Modifiers incl. `partial`, `async`, `override`; attributes with argument text (`[HttpGet("users")]`, `[Route(...)]`); base list (class vs interface undecidable syntactically → put all in `bases`, `extends` matches first base only when it is not `I[A-Z]*`-named — documented heuristic, overridable with `implements`).
4. `using` directives as imports (incl. `global using`, aliases recorded → alias map used to normalise base names within the same file — cheap partial fix for F-5).
5. Calls: invocation expressions, member access text.
6. Partial class merge across binding file set (§11.5).
7. Type normalisation: `global::`, nullable `T?`, `System.` prefix optional, generic arity, tuple types, arrays.

Tests: golden facts for ~25 C# fixtures (controllers, handlers, records, partials, file-scoped namespaces, primary ctors); acceptance 1 & 6 on a C# fixture "microservice" mirroring the requirements' `UserUpdatedHandler` example.

Done when: the requirements document's C# example spec passes/fails exactly as expected.

---

## M5 — Git integration: staged, hook, lock file, ratchet, drift (1.5 w)

Tasks
1. **Git access** (`core/git`): thin `execFile` wrapper (no shell), batched `cat-file --batch`, `ls-files -s -z`, `diff --cached -M --name-status -z`, `rev-parse --git-common-dir --show-toplevel`; clear CS0902 when git is missing.
2. **SourceProvider**: `WorkingTreeProvider`, `IndexProvider` (staged content for both specs and sources), `RevisionProvider` (for HEAD comparisons in M6).
3. **Staged check scope**: changed files ∪ files of specs whose spec file changed ∪ bound files resolved via lock file `resolved` paths (fast path, no repo search unless needed).
4. **Lock file** (§7): generator, deterministic JSON writer, per-item spec hash, `baseline --rebuild`.
5. **Ratchet**: satisfied set update after each successful item; CS0301 on regression; item invalidation when the spec item changes.
6. **Fingerprints & drift**: shape hashing, CS0300 for `implemented` specs, `accept <id>`.
7. **Hook installer**: plain git, `core.hooksPath`, husky, lefthook detection; chaining/backup of foreign hooks; `uninstall-hooks`; `CATSPEC_SKIP`.
8. Hook updates lock files and re-stages them (`hook.stage_generated`), only for specs touched in this commit to avoid noise.

Tests: integration tests creating temp git repos (helper `withRepo(fn)`), covering partial staging, renames in index, hook chaining, Windows line endings; acceptance 4 & 5.

Done when: acceptance 4, 5 pass; hook run on fixture repo ≤ 1 s warm.

---

## M6 — Rename/move detection, heal, large refactors (1.5 w)

Tasks
1. Detection pipeline (§11.4): moved → file-renamed → symbol-renamed with scoring; `RevisionProvider` gives the previous facts (HEAD for staged mode, index for working-tree mode).
2. Body-token similarity: normalised identifier/token sequence from symbol body range; similarity = Jaccard over token 3-grams (cheap, good enough); tokens computed on demand, not cached in lock.
3. `SpecPatch` generation (location ops only), CS0210 with patch; `sync` (dry run diff) / `sync --apply`; `heal.mode=auto` in hook applies + re-stages + prints what changed.
4. Markdown body mentions of old name → info diagnostics.
5. `bind <symbol> --spec <id>`: scaffold binding with current shape (members, bases, ctor params) using CST insert.
6. **Batch refactor mapping** (§11.8): baseline capture (from `HEAD` when no refactor was started), name-free fingerprints, rename-map parser (`symbols`/`namespaces`/`paths`), prefix-rule detection, global one-to-one assignment, mapped/ambiguous/lost report.
7. `sync [--apply|--map|--partial|--update-mentions]` in batch mode (always the same algorithm; during a refactor it uses its baseline and ends it on success): one CST batch per spec file; move lock entries (`resolved`, `satisfied`, fingerprints) to new ids; auto-accept name-only shape changes.
8. Hook grouping: above `refactor.detect_threshold` broken bindings, emit one `CS0215` instead of N errors.
9. `refactor` (start) / `refactor status` / `refactor abort`: baseline + scope + branch in the runtime store; `--allow-wip` relaxation in the hook on that branch only; MCP `start_refactor`/`sync_specs`.

Tests: rename fixtures (class rename, method rename, rename + move, two similar candidates → ambiguous, rename + heavy body change → below threshold); a generated "namespace rename + folder move of 40 classes" fixture; a swap-like rename of two near-identical classes; acceptance 2, 3, 11, 12.

Done when: acceptance 2, 3, 11, 12 pass; no auto edit ever touches contract fields (asserted by a test over all patch ops); the ratchet survives a mass refactor.

---

## M7 — MCP server (1 w)

Tasks
1. `@catspec/mcp` with `@modelcontextprotocol/sdk` stdio transport; `catspec mcp` entry; engine instance kept warm (cache in memory + disk) between calls; config/spec reload on file change (mtime check per call).
2. Tools (§14.1) with zod input schemas, text + `structuredContent` outputs; consistent error mapping (engine diagnostics are results, not protocol errors; protocol errors only for bad input / outside-root paths).
3. Write safety: path guard, location vs contract classification of patches (shared with M6), `dry_run` default, unified diff output.
4. Resources & prompts (§14.2).
5. Docs: setup for Claude Code (`claude mcp add`), Claude Desktop, Cursor, Windsurf. Agent layer (§14.3): `check --in-progress`, `--format agent` with exit 0/2/1, `--max-blocks` loop protection, the `AGENTS.md` block (`init --agents`, `workflow snippet agents`), and the Claude Code `Stop` hook merged into `.claude/settings.json` (F-18).
6. Test harness: in-process MCP client driving the server over a fixture repo; scripted "agent loop" test for acceptance 9; acceptance 10.

Manual validation: run the requirements' user journey with Claude Code on the TS fixture; capture transcript in `docs/spec/reactive-ast-linked-spec-engine/examples/`.

Done when: acceptance 9, 10, 17 pass in automated tests and once manually in Claude Code.

---

## M8 — Workflow profiles (1 w)

Tasks
1. `workflow:` config schema (§17.2): stages, drivers, `produces` templates, start/finish gates, status transitions, placeholders; CS0700 validation; JSON Schema export.
2. Stage resolution: derive a feature's current stage from spec status + artifacts + gate results (no stored state, ADR-004).
3. Gate runner (§17.4): `specs_valid`, `artifacts`, `contracts_declared`, `deps_known`, `deps_ready`, `contracts_pass`, `tasks_done`, `no_drift`, `adr_valid`, `command` (guarded by `allow_commands`, `execFile` per ADR-009).
4. CLI: `next`, `stage start|finish [--force]`, `workflow show|doctor|snippet`.
5. MCP: `next_step`, `start_stage`, `finish_stage`; `workflow` block in `get_spec_context`; generated `stage-<id>` prompts.
6. Presets `catspec` and `custom`; presets `openspec` and `spec-kit` checked against fixture repos built from the tools' current releases (verify layouts and command names first; pin per preset version). Detection in `catspec init`.
7. Hook: `workflow.enforce_in_hook` (CS0703). `init --agents`: optional Claude Code `Stop` hook running `catspec stage finish`.
8. Docs: one page per preset, plus "connect your own skills" with the `snippet` output.

Tests: config validation cases; gate unit tests; fixture repos for `custom` (with stub `sdd-*` skills), `openspec` and `spec-kit`; acceptance 14, 15, 16.

Done when: acceptance 14, 15, 16 pass; `workflow doctor` is clean on all three fixture repos.

---

## M9 — Hardening & 0.1.0 release (1 w)

Tasks
1. Performance: synthetic 10k-file generator (TS + C#), benchmark job asserting budgets (F-16); profile and fix hot spots (likely: globbing, cache I/O → batch reads).
2. Robustness: fuzz adapters with random/truncated files (no throws), huge files skip with CS0901 above size limit.
3. User docs (feature folder `docs/spec/catspec-user-guide/`, per `AGENTS.md`): quick start (5 minutes), spec format reference, rule catalogue, diagnostics reference (generated from code registry), agent integration, FAQ on syntactic limits (F-5).
4. `catspec` meta-package, `npx catspec init` smoke test on clean machines (CI matrix).
5. Example repos: `examples/ts-auth-service` (requirements' `AuthService` journey), `examples/dotnet-user-sync` (`UserUpdatedHandler`).
6. Release 0.1.0 with changesets; announce limitations clearly.

Done when: all MVP acceptance scenarios (1–7, 9–12, 14–17) pass in CI on 3 OSes, budgets met, docs published.

---

## 2. Post-MVP roadmap (not estimated in detail)

| Version | Theme | Content |
|---|---|---|
| 0.2 | CI gate | `check --format sarif` (GitHub code scanning), `--format github` annotations, `catspec ci --base origin/main` (diff-aware), reusable GitHub Action, PR comment bot with drift explanations (source "Phase 3") |
| 0.3 | More languages & depth | Python adapter, Go adapter, `implements_transitive` via in-repo base resolution, optional semantic backend via LSP |
| 0.4 | Agent coordination | **Local claims** (spec §9: `FsClaimStore` with O_EXCL leases in the git common dir, `claim/release/assign` with worktrees, hook enforcement `CS0501`, exclusive refactor claims `CS0503`, MCP `claim_spec`/`release_spec`; acceptance 8, 13); then `GitRefsClaimStore` (`refs/catspec/claims/*`, push = CAS), GitHub App: spec change / issue → DAG evaluation → create branch + issue + trigger agent workflow when unblocked; status sync with PR merge (source "Phase 4") |
| 0.5 | Visual & IDE | `graph --ui` local web server, VS Code extension consuming JSON diagnostics (inline spec ↔ code links) |
| later | Semantic invariants | optional LLM-judged `manual` rules producing *advisory* findings, never gating |

## 3. Risks to the plan

| Risk | Signal | Response |
|---|---|---|
| Tree-sitter WASM grammar build friction | M2 slips > 2 days | use prebuilt `tree-sitter-wasms` package as interim, pin version |
| C# syntax variety (primary ctors, file-scoped ns, source generators) | many golden failures | ship C# as "beta" in 0.1, document unsupported constructs, keep `unresolvable` diagnostics |
| YAML CST edge cases | round-trip failures | restrict writes to block-style sequences; refuse edit with clear message rather than corrupting |
| Hook perf on Windows (process spawn cost) | > 1 s | single long-lived `git cat-file --batch`, avoid `npx` resolution in hook by calling `node_modules/.bin/catspec` directly |
| MCP SDK API changes | breakage | pin SDK minor, adapter layer in `@catspec/mcp` |

## 4. Definition of Done (per task)

- code + unit tests + (where relevant) fixture/golden tests;
- diagnostics added to the code registry with docs text;
- CLI help text and docs page updated;
- no new lint/type errors; CI green on 3 OSes;
- if it changes the spec format: JSON Schema regenerated and an ADR added.
