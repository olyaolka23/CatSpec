# CatSpec — Specification (MVP v0.1): what and why

> CatSpec is an implementation of the *Reactive AST-Linked Spec Engine* idea.
> This document is the **business view**: the problem, goals, users, capabilities, quality
> requirements and acceptance scenarios. **How** it is built (formats, CLI, engine, MCP,
> workflow) is the technical design in [`plan.md`](./plan.md), Part II (`§Dn`). Findings `F-n`
> are in [`analysis.md`](./analysis.md); decisions are in the
> [ADR log](../../architecture/adr/reactive-ast-adr.md).

## 1. Purpose

Specifications in spec-driven development (OpenSpec, Spec-Kit, BMAD) are passive
Markdown: they drift from the code, are not linked to it, and do not stop a
human or an AI agent from breaking architectural agreements.

CatSpec makes specs **active**:

1. each spec is **bound** to concrete code symbols;
2. the spec's invariants are **executable rules** evaluated on the code's syntax tree;
3. a **local gate** (pre-commit hook) blocks commits that break satisfied contracts;
4. AI agents get the spec, its rules and live compliance results through an **MCP server**,
   so "done" is decided by the rules, not by the agent;
5. specs form a **dependency DAG**: work on a spec can't be promoted before its dependencies are done.
   (Locks for parallel agents, *claims*, are designed in plan §D9 but deferred to after the MVP, ADR-014.)

### 1.1 Goals (MVP)

- G1. Parse `*.spec.md` files into a validated model and a dependency DAG.
- G2. Check bindings and structural rules for **TypeScript** and **C#** via Tree-sitter, no compiler.
- G3. Block commits that break contracts, reading the **staged** tree.
- G4. Detect symbol renames/moves and heal spec *locations* with a reviewed or automatic edit.
- G5. Expose specs, verification and safe spec edits to LLM agents via **MCP (stdio)**.
- G6. *(Deferred, ADR-014.)* Local multi-agent claims are post-MVP; see plan §D9.
- G7. Clear, stable, machine-readable diagnostics.
- G8. Fit into the team's existing SDD workflow (OpenSpec, Spec Kit or custom skills) through a **workflow profile**, gating every step (plan §D17).

### 1.2 Non-goals (MVP)

CI/CD integration, GitHub App, local and distributed claims/locks (ADR-014), web graph UI, type-resolved
semantics, IDE plugin, LLM-judged invariants (see analysis §3). The design keeps
extension points for each.

### 1.3 Users

| Persona | Uses |
|---|---|
| Tech lead / architect | writes specs and the ADR log `docs/architecture/adr/<name>-adr.md`, reviews DAG and coverage |
| Developer | implements specs, gets fast hook feedback, heals renames |
| AI coding agent (Claude Code, Cursor, Windsurf) | reads context, self-verifies via MCP/CLI |

---

## 2. Concepts & glossary

| Term | Meaning |
|---|---|
| **Spec** | One `*.spec.md` file: YAML frontmatter (machine) + Markdown body (human). Identified by `id`. |
| **Binding** | A link from a spec to one code symbol, with an expected shape. |
| **Rule** | An invariant with an enforcement class: `structural`, `test`, `query`, `manual`. |
| **Contract** | All enforceable expectations of a spec: binding shapes + enforceable rules. |
| **Symbol** | A normalised declaration extracted from the AST (class, interface, method, function…). |
| **Diagnostic** | One check result with a stable code. |
| **Lock file** | Generated, committed record of observed facts per spec (ratchet, fingerprints). |
| **Claim** | *(Post-MVP.)* A runtime lease giving one owner (agent/dev) exclusive right to change a spec's scope. |
| **Drift** | The code's shape changed without a matching spec change. |
| **Violation** | The code fails a declared contract. |

---

## 3. How CatSpec works

What CatSpec does for its users. How it is built is in [`plan.md`](./plan.md), Part II (`§Dn`).

| Capability | What the user gets | Design |
|---|---|---|
| **Specs linked to code** | A spec names the classes, methods and interfaces it is about. Moving a file doesn't break the link. | §D5, §D11.5 |
| **Executable rules** | Contracts such as "implements X", "has method Y" or "Domain must not import Infrastructure" are checked automatically. Behaviour that can't be checked from code is tracked, not faked. | §D6 |
| **Status-aware checks** | Work in progress only gets warnings; something that has passed once can't silently break again; finished specs are fully enforced. | §D7, §D8 |
| **Commit gate** | A pre-commit hook checks exactly what is being committed, in under a second. | §D13, §D11.7 |
| **Renames and refactors** | Renamed or moved code is detected and the specs are fixed with one command, even for large refactors. | §D11.4, §D11.8 |
| **AI agents** | Agents read the spec, check their own work and can't stop or "pass" by weakening the spec. "Done" is decided by CatSpec. | §D14 |
| **Any SDD workflow** | Teams keep OpenSpec, Spec Kit or their own skills; CatSpec checks each step. | §D17 |
| **Clear diagnostics** | Every problem has a stable code, the exact location, what was expected and found, and how to fix it. | §D12 |
| *Later:* agent locks | Coordination of several agents on one machine (post-MVP). | §D9 |

---

## 4. Non-functional requirements

| Area | Requirement |
|---|---|
| Platforms | Linux, macOS, Windows; Node ≥ 22.12; git ≥ 2.30 |
| Install | `npm i -D catspec` or `npx catspec`; no native compilation |
| Determinism | same input → byte-identical output and lock files |
| Robustness | files with parse errors give partial facts + `CS0901`, never a crash |
| Security | no network; MCP restricted to repo root; no code execution except `--run-tests` with configured command |
| Quality | ≥ 90 % line coverage in `core`; golden tests per adapter; CST round-trip tests |
| Docs | README quick start, spec format reference, rule catalogue, diagnostics reference, agent integration guide |
| Licence | Apache-2.0 (as in repo) |

---

## 5. Acceptance scenarios (MVP)

1. **Rename blocked**: an `implemented` spec binds `AuthService.validateToken`; renaming it to `checkToken` and committing fails with `CS0203` + did-you-mean.
2. **Rename healed**: renaming class `UserHandler`→`UserUpdatedHandler` with `heal.mode=suggest` fails with `CS0210` and a patch; `catspec sync --apply` fixes the spec and the next commit passes.
3. **Move tolerated**: moving the file to another folder without renaming passes (symbol-first binding).
4. **In-progress ratchet**: a missing method in an `in-progress` spec is a warning; after it is implemented and committed, deleting it is an error.
5. **Partial staging**: a staged correct version + unstaged broken version passes; the reverse fails.
6. **Architecture rule**: `src/Domain/**` importing `src/Infrastructure/**` fails with `CS0603`.
7. **DAG**: `catspec status user-sync-handler in-progress` refuses (`CS0502`) while `cdc-core-events` is not `implemented`.
8. *(Post-MVP, ADR-014.)* **Claims**: two agents claiming overlapping specs — second gets `CS0500`; committing into a foreign claim's files fails with `CS0501`.
9. **MCP loop**: agent calls `get_spec_context`, writes code with `signIn`, `check_compliance` returns `CS0203 expected login, found signIn`, agent fixes, the next check returns `done: true`, `set_spec_status implemented` succeeds.
10. **Agent can't weaken contract**: `update_spec_bindings` removing a member returns a proposal and does not write when `allow_contract_edits=false`.
11. **Mass refactor**: renaming namespace `Identity` → `Accounts` (40 bound classes) and moving the folder in one commit. The hook shows one `CS0215`; `catspec sync --apply` maps all 40 with no manual edits, ratchet entries are preserved, and the commit passes.
12. **Ambiguous refactor**: two near-identical handlers renamed at once without a map. `catspec sync --apply` reports `CS0216` with candidates and changes nothing; with `--map` it succeeds.
13. *(Post-MVP, ADR-014.)* **Refactor vs claims**: `catspec refactor` over a scope another agent has claimed fails with `CS0503`; while the refactor is active, that agent's new claim in the scope is refused.
14. **Custom workflow**: with `preset: custom` and skills `sdd-spec/plan/task/close`, `catspec next login` names `sdd-plan` after `spec.md` exists, and `catspec stage finish close login` fails with `CS0702` (`contracts_pass`) while `login()` is missing. Once fixed, it sets `implemented`.
15. **OpenSpec preset**: in a repo with `openspec/changes/add-login/`, `catspec stage start archive add-login` is refused while contracts fail or tasks are unticked. After it passes, the archived change's `*.spec.md` stays enforced.
16. **Doctor**: a config naming skill `sdd-plan` that doesn't exist under `skills_dir` gets `CS0704` from `catspec workflow doctor`.
17. **Agent can't stop early**: with the Claude Code `Stop` hook installed, `register-api` `in-progress` and `login()` missing, the agent's attempt to end its turn is blocked (exit 2) with the fix list. After the fix, the hook exits 0. With the same failure 3 times in a row, the agent is let go and the user is told the item is stuck.
