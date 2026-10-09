# CatSpec — Requirements Analysis

> Source: *Reactive AST-Linked Spec Engine* (requirements document, RU/EN).
> This file is a critical re-analysis of that document. It lists what the source
> gets right, where it is vague, contradictory or technically infeasible, and the
> design decisions taken to resolve each point. The resulting product spec is in
> [`spec.md`](./spec.md); the implementation plan is in [`plan.md`](./plan.md).

---

## 1. What the source document asks for (condensed)

| # | Capability | Source wording |
|---|---|---|
| C1 | **AST binding** — every requirement points at concrete code elements (class, method, endpoint, module) | "Bi-directional Sync & AST Binding" |
| C2 | **Drift detection** — code changes that bypass the spec are detected from `git diff` + AST | "Spec drift", Strict Mode |
| C3 | **Auto-heal** — renames done in the IDE update the spec automatically | "Auto-Heal Mode (Local)", `spec sync` |
| C4 | **Executable invariants** — spec contracts compiled into AST asserts / tests; a task is done when they pass | "Executable Invariants" |
| C5 | **Spec DAG** — `depends_on` forms a graph; work cannot start before dependencies are done | "DAG Orchestrator" |
| C6 | **Agent locks** — parallel agents get isolated nodes and atomic locks on files | "Task Locks", `agent_lock`, `spec agent assign` |
| C7 | **Linter / gate** — commit (MVP) or PR (later) is blocked on violations | `spec check`, pre-commit hook, CI |
| C8 | **LLM bridge** — MCP server with `get_spec_context`, `verify_ast_compliance`, `check_dependencies`, `mark_spec_resolved`, `update_spec_bindings` | MCP section |
| C9 | **Visualisation** — DAG graph for a tech lead | `spec graph --ui` |
| C10 | **Language-agnostic parsing** — Tree-sitter, no compilation; C# + one scripting language first | Core components |
| C11 | **GitHub orchestration** — GitHub App, issues/PR state, worktree per task (post-MVP) | Phase 4 |

The final section of the source narrows the MVP to: CLI + pre-commit hook + MCP
server, no CI/CD. This analysis keeps that MVP boundary. Local locks (C6) were
first included, then deferred to after the MVP (ADR-014): they don't remove merge
conflicts, they mainly help several agents working at once on one machine, and the
core value (check, hook, MCP) doesn't depend on them. Their design (F-10) is kept for later.

---

## 2. Gaps, contradictions and infeasible parts

Each finding has an ID (`F-n`) that the spec and plan refer to.

### F-1. Runtime state is stored in versioned Markdown (`agent_lock`, `status`)

`agent_lock: "github-agent-id-104"` lives in the spec frontmatter. A lock is
**ephemeral runtime state**; putting it in a committed file means:

- the lock is only visible after commit + push/pull → it is not atomic at all;
- two branches that each take a lock produce a merge conflict in the spec;
- a crashed agent leaves a stale lock in history forever.

`status: in-progress` has a milder version of the same problem: part of the
status can be **derived** (are all contracts satisfied?) and part is a human
**decision** (is this spec approved / deprecated?). Mixing them invites the very
drift the tool is meant to remove.

**Decision.** Three kinds of state, three places:

| Kind | Example | Where | Committed |
|---|---|---|---|
| Declared (human intent) | contracts, `depends_on`, lifecycle `status` | `*.spec.md` frontmatter | yes |
| Observed (machine facts) | which contracts were satisfied, signature fingerprints | `docs/spec/<feature>/<spec-id>.lock.json` | yes, generated |
| Runtime (ephemeral) | agent locks, parse cache | `$(git rev-parse --git-common-dir)/catspec/` | **no** |

Using the git *common* dir means all worktrees of one clone share one lock
table — exactly the scope where local agents compete.

### F-2. "Invariants" in prose are not executable

`[AST-Invariant] HandleAsync must be idempotent` cannot be checked from an AST.
Idempotency is a behavioural property. Same for "must use DI for ILogger" —
that one *is* structurally checkable, but only if it is written in a
machine-readable form. The source never defines that form, so "executable
invariants" is undefined.

**Decision.** Invariants are classified by how they are enforced:

| Class | Checked by | Example | Gate effect |
|---|---|---|---|
| `structural` | AST rule engine | class implements X, method exists, ctor requires `ILogger`, no import of `infra/*` | can block |
| `test` | a linked test symbol must exist; optionally executed | `HandleAsync_IsIdempotent` test | can block |
| `query` | raw Tree-sitter query (escape hatch) | "no `Console.WriteLine` in handler" | can block |
| `manual` | human / LLM review, tracked only | "must be idempotent" (if no test) | never blocks; reported as *unenforced* |

The Markdown body may keep human prose, and each prose bullet can reference a
rule id (`[rule:no-console]`). The linter reports prose invariants that have no
backing rule. This turns "executable" from a slogan into a measurable ratio
(*enforcement coverage*).

### F-3. "100 % coverage of spec nodes" is undefined

What is a "node" — a spec, a binding, a task, an invariant? Is it forward
coverage (spec → code) or reverse (code → spec)?

**Decision.** Three metrics, all reported, only the first can gate in MVP:

1. **Contract satisfaction** — share of enforceable rules (structural/test/query)
   that pass, per spec and repo-wide.
2. **Enforcement coverage** — share of invariants that are enforceable (not `manual`).
3. **Code coverage by specs** (reverse) — share of symbols in configured
   source globs that are bound by any spec. Informational; useful for
   architecture-heavy teams, noisy otherwise.

### F-4. Enforcing contracts during implementation blocks every commit

If `user-sync-handler` is `in-progress`, its class does not exist yet. A naïve
pre-commit hook fails every commit of the developer implementing it — the team
disables the hook on day two.

**Decision.** Enforcement depends on lifecycle status, plus a **ratchet**:

| Status | Missing / failing contract |
|---|---|
| `draft`, `ready` | not checked (info only on request) |
| `in-progress` | warning — **except** contracts recorded as satisfied in the lock file, which are errors (regression) |
| `implemented` | error |
| `deprecated` | not checked |

The ratchet: once a contract has passed, the lock file records it; from then on
it can only be removed by changing the spec. Progress is free, regressions are blocked.

### F-5. Tree-sitter gives syntax, not semantics

The source assumes checks like `implements: IMessageHandler<UserUpdatedEvent>`.
Tree-sitter does not resolve types. It cannot see:

- inheritance chains (`A : B`, `B : IMessageHandler<…>`);
- `using` aliases, TypeScript re-exports, Python star-imports;
- generated / source-generator code;
- partial classes split across files (C#);
- decorators that add members at runtime (Python, TS).

**Decision.** Be explicit that matching is **syntactic with normalisation**:

- type references are normalised (whitespace, `global::`, nullable `?`,
  generic arity) and matched by *qualified-name suffix*
  (`IMessageHandler<UserUpdatedEvent>` matches
  `Contracts.IMessageHandler<Events.UserUpdatedEvent>`);
- `implements` checks the *direct* base list; `implements_transitive` is a later,
  opt-in feature that follows bases found inside the repo;
- C# `partial` declarations are merged across the binding's file set;
- every limitation produces a distinct diagnostic (`unresolvable`) instead of a
  false error, and can be waived.

A semantic backend (Roslyn / tsserver / LSP) is a post-MVP plug-in point behind the
same adapter interface.

### F-6. Bindings keyed by file path break on the most common refactoring

`file: src/…/UserUpdatedHandler.cs` + `symbol: UserUpdatedHandler`. Moving the
file — the most frequent refactor — breaks the binding even though nothing
architecturally changed. The source then needs "auto-heal" to fix a problem the
format itself created.

**Decision.** **Symbol-first bindings.** `symbol` is a (qualified) name; `file`
is an optional *hint* (path or glob). Resolution order: hint → reverse index →
repo-wide search in the language's source globs. A moved file therefore stays
valid; only an ambiguous or missing symbol is an error. Auto-heal then only has
to handle real renames.

### F-7. Auto-heal is under-specified and risky

"If it finds the class was renamed using IDE refactoring (tracking git diff)" —
git tracks *file* renames (similarity), not *symbol* renames. And silently
rewriting the spec inside a pre-commit hook changes the meaning of the commit.

**Decision.** Rename detection is a scored heuristic, and edits are split by risk:

1. Candidate = symbol of the same kind that *appeared* in the diff while the
   bound symbol *disappeared* (same file, or file renamed by `git diff -M`).
2. Score = member-name Jaccard × body-token similarity (+ bonus for same file).
3. Only a unique candidate with score ≥ threshold (default 0.8) is proposed.
4. **Location edits** (`symbol`, `file`) may be applied automatically
   (`heal: auto`) and re-staged; **contract edits** (members, implements, rules)
   are never automatic.
5. Edits go through a YAML CST (comment- and formatting-preserving), never through
   a parse → stringify round-trip (which is what `gray-matter` does).

### F-8. "Signature changed" requires a baseline the source does not define

To say "the developer changed the signature of a method *bypassing the spec*"
there must be a stored expected signature. Either the spec declares the full
signature, or a snapshot is kept.

**Decision.** Both, explicitly:

- if a member declares `params`/`returns`, they are contracts (checked always);
- otherwise the lock file stores a **shape fingerprint** (kind, name, param types,
  return type, modifiers, bases) of each bound symbol; a change to the shape of a
  symbol in an `implemented` spec is reported as **drift** (`warn` by default,
  `error` in `drift: strict`) and resolved by `catspec accept <spec-id>`
  — the same model as snapshot testing.

Body changes never count as drift.

### F-9. The pre-commit hook must check the *staged* tree, not the working tree

`git diff --cached` is mentioned, but validation then reads files from disk. A
partially staged file would be validated in a state that is not being committed.

**Decision.** In `--staged` mode every source and spec file is read from the
index (`git cat-file --batch` over `git ls-files -s`), never from disk. The hook
must also coexist with existing hook managers (husky, lefthook, pre-commit) and
respect `core.hooksPath`.

### F-10. Locks are only advisory unless something enforces them

A lock file cannot stop an agent from editing a file. The source implies
"atomic locks on files" prevent conflicts but defines no enforcement point.

**Decision.** *(Deferred to post-MVP by ADR-014; the design below is kept for that release.)*

- **Acquire** is atomic: lock records are created with `O_EXCL` (or a
  transactional SQLite file) in the git common dir; leases have TTL + heartbeat;
  stale leases are reclaimable.
- **Lock scope** = files of the spec's resolved bindings ∪ the spec's declared
  `scope` globs. Two specs with overlapping scope cannot both be claimed.
- **Enforcement** happens at the pre-commit hook: a commit that touches a path
  locked by *another* owner is rejected. Owner identity comes from the worktree
  (`catspec assign` records worktree → owner) or `CATSPEC_AGENT_ID`.
- Distributed locks (across machines) are post-MVP; the recommended mechanism is
  git refs (`refs/catspec/locks/<spec-id>`), because `git push` of a new ref is a
  server-side compare-and-swap that needs no extra service.

### F-11. DAG semantics are incomplete

Not defined: what "dependency done" means locally (merged where?), cycle
handling, missing dependency ids, whether `depends_on` is spec-level or
task-level.

**Decision.**

- DAG is **spec-level** in MVP. Tasks inside a spec are a Markdown checklist
  (informational, counted in progress).
- A dependency is **satisfied** when its status is `implemented` **and** its
  enforceable contracts pass on the current tree.
- Cycles, unknown ids and self-dependencies are spec validation errors (`catspec check --specs-only`).
- Moving a spec to `in-progress` with unsatisfied dependencies is refused (`--force` to override, logged).

### F-12. "Contradicts architecture-spec.md" is not checkable as stated

A free-text global document cannot be checked for contradictions.

**Decision.** The ADR log `guidelines/architecture/<name>-adr.md` is a spec of `type: architecture`: its body is the
ADR log and its frontmatter holds the rules that enforce those decisions. The rules are
**global**: layer/import boundaries (`forbid_import from: src/Domain/** to: src/Infrastructure/**`),
naming conventions (`*Handler` must implement `IMessageHandler<…>`),
forbidden calls. They are checked over all source files, using the same rule engine.

### F-13. MCP write tools need a safety model

`update_spec_bindings(spec_id, new_bindings_json)` lets an LLM rewrite the
contract it is being checked against — an agent could "pass" by weakening the spec.

**Decision.** Writes are split the same way as auto-heal (F-7):

- location edits (`symbol`, `file`) — allowed by default;
- contract edits — disabled by default (`mcp.allow_contract_edits: false`); when
  disabled the tool returns a proposed patch for a human to apply;
- all writes are restricted to `*.spec.md` / lock files inside the repo root
  (path traversal guarded) and are visible in `git diff`.

`mark_spec_resolved` must refuse to set `implemented` if contracts fail.

### F-14. Diagnostics quality decides adoption

The source correctly asks for semantic error messages ("Expected class
`UserUpdatedHandler` implementing `IMessageHandler`, found `UserHandler` without
interface"). That needs a defined diagnostic model, not ad-hoc strings.

**Decision.** Every diagnostic has a stable code, severity, the spec location
(file:line of the binding/rule in frontmatter), the code location (if any), a
message, and machine-readable `expected` / `actual` / `suggestions`
(did-you-mean by edit distance). Reporters: `text`, `json`; `sarif` reserved for CI.

### F-15. Naming and CLI collision

A binary called `spec` collides with existing tools and is ungoogleable.

**Decision.** Product **CatSpec**, binary `catspec`, spec files `*.spec.md`,
config `catspec.yaml` at the repo root, specs in `docs/spec/<feature>/`. (`*.spec.md` can clash with test naming in some
JS repos — the glob is configurable.)

### F-16. Performance is unstated but critical for a hook

A pre-commit hook slower than ~1–2 s gets bypassed with `--no-verify`.

**Decision.** Budgets: staged check < 1 s for a commit touching ≤ 20 bound files
on a 10k-file repo (warm cache); full `catspec check` < 10 s (cold) on the same.
Means: parse only files that are bound or changed; cache parse results keyed by
**git blob SHA** (content-addressed, free invalidation); lazy repo-wide symbol index.

### F-17. False positives need an escape hatch with accountability

Without a waiver mechanism the first unfixable false positive leads to the hook
being removed.

**Decision.** `waivers:` in the spec frontmatter: rule id, reason (required),
optional `until` date. Expired waivers become errors. Waivers are listed in reports.

### F-18. "Task is done when invariants pass" needs an integration point

The source says completion is decided by compiled invariants, not by the agent,
but defines no hook into the agent loop.

**Decision.** Three integration points: (a) MCP `check_compliance` for
self-checks; (b) `catspec check --spec <spec-id>` exit code for any agent harness,
e.g. a Claude Code `Stop` / `PostToolUse` hook that feeds diagnostics back to the
agent; (c) the pre-commit gate as the backstop.

### F-19. Timeline is optimistic

The source plans the MVP in 5 weeks including two languages, a hook, an MCP
server, rename detection and (implicitly) locks. With the clarifications above
(CST editing, staged reading, ratchet, C# partial classes, golden tests per
grammar) a realistic estimate for one engineer is **~12.5 weeks** (~11 if the C# adapter is built in parallel; includes large-refactor support, spec §11.8, and workflow profiles, spec §17; claims deferred by ADR-014); see the plan.

### F-20. The source assumes CatSpec owns the whole workflow

The source describes its own commands for every step (`spec init`, `spec agent assign` …).
Real teams already plan with OpenSpec, Spec Kit or their own agent skills, and won't switch
tools to get enforcement.

**Decision.** CatSpec is **workflow-agnostic**. A `workflow:` profile in `catspec.yaml`
(presets `catspec`, `openspec`, `spec-kit`, or `custom` stages pointing at the team's skills)
tells CatSpec what the steps are. CatSpec then attaches to each step with entry and exit
**gates** and status transitions, and tells the agent what comes next. It never performs the
creative work or calls an LLM itself (spec §17, ADR-015).

---

## 3. Explicitly out of MVP scope

| Item | Why deferred | Prepared for by |
|---|---|---|
| CI linter, PR comments, SARIF upload | source's own MVP decision | `json` reporter, stable codes, `sarif` reporter slot |
| GitHub App orchestrator, issue/PR state machine | needs hosted service | spec status model, DAG API |
| Local claims / agent locks, `assign` with worktrees | don't prevent merge conflicts; value mainly for many parallel agents; ~1.5 weeks plus concurrency risk (ADR-014) | `scope` field parsed; design in F-10 and spec §9 |
| Distributed locks | needs a shared medium | lock-store interface; git-refs design (F-10) |
| `graph --ui` web server | nice-to-have | `graph --format mermaid|dot|json` in MVP |
| Semantic backends (Roslyn, tsserver) | heavy | language adapter interface |
| LLM-judged `manual` invariants | non-deterministic gate | `manual` class is tracked already |
| IDE plugin / LSP | separate product surface | JSON diagnostics with ranges |
| Infrastructure bindings (`AzureServiceBus topic:…`) | no AST to check against | parsed & shown in context; not validated |

## 4. Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| False positives from syntactic matching | hook disabled | status-aware enforcement, ratchet, `unresolvable` diagnostics, waivers |
| Writing specs is extra work | low adoption | `catspec bind` scaffolds bindings from existing code; MCP lets the agent draft specs |
| Grammar/version churn in Tree-sitter | broken parsing | pin grammar WASM versions, golden tests per adapter |
| Lock file merge conflicts | friction | one lock file per spec, sorted keys, deterministic output, `catspec baseline --rebuild` |
| Agents weakening specs to pass | false "done" | contract edits disabled for MCP by default, spec changes visible in diff, ratchet |
| Hook latency | `--no-verify` | blob-SHA cache, parse only bound/changed files, budgets tested in CI |
