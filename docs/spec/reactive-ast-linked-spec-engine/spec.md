# CatSpec — Product & Technical Specification (MVP, v0.1)

> CatSpec is an implementation of the *Reactive AST-Linked Spec Engine* idea.
> Design decisions marked `F-n` are justified in [`analysis.md`](./analysis.md).
> The build order is in [`plan.md`](./plan.md).

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
5. specs form a **dependency DAG**, and parallel agents **claim** specs with
   atomic local locks.

### 1.1 Goals (MVP)

- G1. Parse `*.spec.md` files into a validated model and a dependency DAG.
- G2. Check bindings and structural rules for **TypeScript** and **C#** via Tree-sitter, no compiler.
- G3. Block commits that break contracts, reading the **staged** tree.
- G4. Detect symbol renames/moves and heal spec *locations* with a reviewed or automatic edit.
- G5. Expose specs, verification and safe spec edits to LLM agents via **MCP (stdio)**.
- G6. Local multi-agent coordination: claim/release specs, worktree per spec, lock enforcement in the hook.
- G7. Clear, stable, machine-readable diagnostics.

### 1.2 Non-goals (MVP)

CI/CD integration, GitHub App, distributed locks, web graph UI, type-resolved
semantics, IDE plugin, LLM-judged invariants (see analysis §3). The design keeps
extension points for each.

### 1.3 Users

| Persona | Uses |
|---|---|
| Tech lead / architect | writes specs and `guidelines/architecture/ADR.md`, reviews DAG and coverage |
| Developer | implements specs, gets fast hook feedback, heals renames |
| AI coding agent (Claude Code, Cursor, Windsurf) | reads context, self-verifies, claims specs via MCP/CLI |

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
| **Claim** | A runtime lease giving one owner (agent/dev) exclusive right to change a spec's scope. |
| **Drift** | The code's shape changed without a matching spec change. |
| **Violation** | The code fails a declared contract. |

---

## 3. Repository layout

Default layout. CatSpec uses **feature folders**: every spec, and the human docs
that go with it, lives in a folder named after its feature (epic).

```
<repo>/
  catspec.yaml                          # config (§4)
  guidelines/
    architecture/
      ADR.md                            # architecture spec, type: architecture (§6.4):
                                        #   frontmatter = global rules, body = ADR log
  docs/spec/
    <feature>/                          # kebab-case full feature/epic name, e.g. react-sdd
      analysis.md                       # human docs (optional, opaque to the engine)
      spec.md
      plan.md
      tasks.md
      <spec-id>.spec.md                 # machine spec(s) of this feature (§5)
      <spec-id>.lock.json               # generated, committed, next to its spec (§7)
  <git-common-dir>/catspec/             # runtime, NOT committed (§9)
    claims/<spec-id>.json
    cache/<blob-sha>.json
```

- `catspec init` creates this layout, a starter `ADR.md`, and an example feature folder
  with `spec.md`, `plan.md` and one `*.spec.md`. `catspec init --agents` also appends
  the layout rules to `AGENTS.md` (created if missing) so coding agents follow them.
- `catspec lint` warns (`CS0106`) when a `*.spec.md` is outside `docs/spec/<feature>/`
  or sits deeper than one folder level, and when the architecture spec is not at the
  configured path. Teams with another layout set `layout: free` in the config.
- Human docs (`analysis.md`, `spec.md`, `plan.md`, `tasks.md`) never match the spec glob
  (`*.spec.md` requires the `.spec.md` suffix), so the engine ignores them.

---

## 4. Configuration — `catspec.yaml` (repo root)

```yaml
version: 1
layout: feature-folders  # feature-folders | free
specs:
  include: ["docs/spec/*/*.spec.md"]
  architecture: "guidelines/architecture/ADR.md"
languages:
  typescript:
    include: ["src/**/*.{ts,tsx}"]
    exclude: ["**/*.d.ts", "**/node_modules/**"]
  csharp:
    include: ["src/**/*.cs"]
    exclude: ["**/obj/**", "**/bin/**", "**/*.g.cs"]
enforcement:
  drift: warn            # off | warn | strict          (F-8)
  unresolvable: warn     # warn | error                 (F-5)
  unenforced_prose: warn # off | warn                   (F-2)
heal:
  mode: suggest          # off | suggest | auto         (F-7)
  threshold: 0.8
hook:
  stage_generated: true  # re-stage lock files / auto-healed specs
claims:
  ttl: 4h
  enforce_in_hook: true
mcp:
  allow_location_edits: true
  allow_contract_edits: false   # F-13
```

The config is validated with the same schema library as specs; a JSON Schema is
published for editor autocompletion. All keys have defaults; `catspec init`
writes a minimal file.

---

## 5. Spec file format — `*.spec.md`

### 5.1 Example

```markdown
---
catspec: 1
id: user-sync-handler
title: User sync handler
type: feature
status: in-progress
depends_on: [cdc-core-events]
owners: ["@team-identity"]
scope:
  - src/Services/Identity/Handlers/**
bindings:
  - id: handler
    symbol: Identity.Handlers.UserUpdatedHandler
    kind: class
    file: src/Services/Identity/Handlers/*.cs        # hint, optional
    implements: ["IMessageHandler<UserUpdatedEvent>"]
    constructor:
      requires: [ILogger, IEventStore]
    members:
      - name: HandleAsync
        kind: method
        params: [UserUpdatedEvent, CancellationToken]
        returns: Task
        modifiers: [public]
rules:
  - id: no-console
    class: structural
    forbid_call: "Console.WriteLine"
    within: handler
  - id: idempotent
    class: test
    test: { symbol: UserUpdatedHandlerTests.HandleAsync_IsIdempotent, lang: csharp }
  - id: dedup-review
    class: manual
    text: Deduplication must use the message id, not the payload hash.
infrastructure:
  - resource: AzureServiceBus
    entity: "topic:user-events"
waivers: []
---

# User sync handler

## Contracts
- [rule:idempotent] `HandleAsync` must be idempotent.
- [binding:handler] Dependencies `ILogger` and `IEventStore` are injected.
- [rule:no-console] No direct console logging.

## Tasks
- [ ] Create a class implementing the bus handler interface.
- [ ] Add message de-duplication.
```

### 5.2 Frontmatter schema

| Field | Type | Req. | Notes |
|---|---|---|---|
| `catspec` | int | yes | schema version, `1` |
| `id` | string `^[a-z0-9][a-z0-9-]{1,63}$` | yes | unique across repo |
| `title` | string | no | defaults to first `#` heading |
| `type` | `feature \| component \| contract \| architecture \| adr` | yes | `architecture` makes rules global (§6.4) |
| `status` | `draft \| ready \| in-progress \| implemented \| deprecated` | yes | human-owned lifecycle (§8) |
| `depends_on` | string[] | no | spec ids; must exist, no cycles |
| `owners` | string[] | no | informational |
| `scope` | glob[] | no | extra paths that belong to this spec (lock scope, F-10) |
| `bindings` | Binding[] | no | §5.3 |
| `rules` | Rule[] | no | §6 |
| `infrastructure` | object[] | no | free-form, passed to agents, not validated (MVP) |
| `waivers` | Waiver[] | no | §6.5 |
| `links` | `{ pr?, issue?, commit? }` | no | set by `mark_spec_resolved` |

Unknown top-level keys → warning `CS0102` (not error) so teams can add metadata.

### 5.3 Binding

| Field | Type | Notes |
|---|---|---|
| `id` | string | local id, unique in spec; referenced by rules (`within`) and prose (`[binding:id]`). Defaults to `symbol`'s last segment. |
| `symbol` | string | qualified name: C# `Namespace.Type[.Member]`, TS `path/to/module#Name[.member]` or bare `Name`. Matched by suffix (F-5). |
| `kind` | `class \| interface \| struct \| enum \| record \| function \| method \| type \| module` | |
| `lang` | language id | inferred from `file` or config when omitted |
| `file` | path \| glob \| list | **hint** (F-6). C# partial classes: all matches are merged. |
| `implements` | string[] | direct base types/interfaces (normalised suffix match) |
| `extends` | string | direct base class |
| `attributes` | string[] | C# attributes / TS decorators, e.g. `HttpGet("users")`, `Controller` — name match, args match if given |
| `constructor.requires` | string[] | types that must appear among parameters of at least one constructor (DI check) |
| `members` | (string \| Member)[] | string shorthand = name-only member of any kind |
| `exported` | bool | TS: must be exported; C#: must be `public` |

`Member`: `name`, `kind` (`method|property|field|event|constructor`), `params`
(type strings, positional; `"*"` = any), `returns`, `modifiers`
(`public|private|protected|internal|static|async|abstract|override|readonly`),
`attributes`, `optional` (bool, default false).

When `params`/`returns` are omitted, the member's shape is protected only by the
drift fingerprint (§7.2), not by the contract.

### 5.4 Markdown body

Parsed with remark (mdast). The engine extracts:

- prose invariant references `[rule:<id>]`, `[binding:<id>]` — unknown ids → error `CS0110`;
- bullets under a heading named `Contracts` / `Invariants` that have **no** reference → `CS0111 unenforced prose invariant` (per `enforcement.unenforced_prose`);
- task checklist items (`- [ ]` / `- [x]`) under `Tasks` → progress `done/total`.

The body is otherwise opaque and returned verbatim to agents.

---

## 6. Rules (invariants)

### 6.1 Classes

| Class | Evaluated by | Blocks commit? |
|---|---|---|
| `structural` | rule engine on normalised symbols | yes (status-dependent, §8) |
| `query` | raw Tree-sitter query on files in scope | yes |
| `test` | linked test symbol must exist; executed only with `--run-tests` | yes (existence) |
| `manual` | nobody; tracked | never |

### 6.2 Structural rule catalogue (MVP)

| Key | Meaning | Params |
|---|---|---|
| `forbid_call` | no call expression whose callee text matches | pattern (`*` wildcard), `within` |
| `require_call` | at least one matching call in the target | pattern, `within` (binding or member: `handler.HandleAsync`) |
| `forbid_import` | files matching `from` must not import modules matching `to` | `from` glob, `to` pattern(s) |
| `allow_import_only` | files in `from` may import only `to` patterns (+ stdlib) | |
| `naming` | symbols of `kind` matching `name` must satisfy `implements` / `extends` / `attributes` / `in_path` | |
| `must_not_exist` | a symbol pattern must not exist (deprecations) | `symbol`, `kind` |

Common rule fields: `id`, `class`, `message` (optional custom text), `adr` (ADR id the rule
enforces, §6.4) and `paths` (glob list narrowing the files checked).
`within` scopes a rule to a binding (or `binding.member`); without it the scope is
the spec's resolved files. In `architecture` specs the default scope is all
configured sources.

### 6.3 `query` rules

```yaml
- id: no-sync-over-async
  class: query
  lang: csharp
  query: |
    (member_access_expression name: (identifier) @n (#eq? @n "Result")) @hit
  expect: absent          # absent | present
  within: handler
  message: "Do not block on Task.Result inside handlers."
```

Queries are compiled at load time; invalid query → `CS0130`.

### 6.4 Global rules (`guidelines/architecture/ADR.md`)

The architecture spec is a single file at `guidelines/architecture/ADR.md`
(configurable via `specs.architecture`). Its frontmatter holds the global rules;
its Markdown body is the project's Architecture Decision Record log (one
`## ADR-NNN: <title>` section per decision, append-only). Each global rule should
name the decision it enforces (`adr: ADR-003`); `catspec lint` reports unknown ADR ids (`CS0112`).

Rules in a `type: architecture` spec apply repo-wide and are checked on every
`check` (in `--staged` mode: on changed files only). Architecture specs have no
bindings requirement and no `in-progress` relaxation (always enforced unless `draft`).

### 6.5 Waivers

```yaml
waivers:
  - rule: no-console
    reason: "Bootstrap logging before DI container is built"
    until: 2026-12-31
    paths: ["src/Bootstrap/**"]   # optional narrowing
```

A waived diagnostic becomes `info` (`CS0400`); an expired waiver → error `CS0401`.

---

## 7. Lock file — `docs/spec/<feature>/<spec-id>.lock.json` (observed state)

Generated, deterministic (sorted keys, stable formatting), committed. One file
per spec, stored next to its `*.spec.md`, to minimise merge conflicts and keep a
feature folder self-contained. `catspec lock --rebuild` regenerates all.

```json
{
  "spec": "user-sync-handler",
  "specHash": "sha256:…",
  "satisfied": ["binding:handler", "binding:handler.HandleAsync", "rule:no-console"],
  "symbols": {
    "handler": {
      "resolved": "src/Services/Identity/Handlers/UserUpdatedHandler.cs#Identity.Handlers.UserUpdatedHandler",
      "fingerprint": "sha256:…",
      "shape": { "kind": "class", "bases": ["IMessageHandler<UserUpdatedEvent>"], "members": ["HandleAsync(UserUpdatedEvent,CancellationToken):Task"] }
    }
  }
}
```

### 7.1 Ratchet (F-4)
Every check that sees a contract item pass adds it to `satisfied`. Once satisfied,
a failure of that item is an **error** regardless of `in-progress` status. Items
leave `satisfied` only when removed from / changed in the spec (detected via `specHash`
per item).

### 7.2 Fingerprints & drift (F-8)
Shape = kind, normalised name, bases, attributes, member signatures (name, param
types, return type, modifiers). Bodies are excluded. For `implemented` specs, a
shape change → `CS0300 drift` (severity from `enforcement.drift`).
`catspec accept <spec-id>` records the new shape.

---

## 8. Lifecycle & enforcement matrix

```
draft ──► ready ──► in-progress ──► implemented ──► deprecated
                 ▲        │  (promote: all enforceable contracts pass)
                 └────────┘  (demote: allowed, manual)
```

| Item state \ Spec status | draft / ready | in-progress | implemented | deprecated |
|---|---|---|---|---|
| contract fails, never satisfied | — | warning | **error** | — |
| contract fails, previously satisfied | — | **error** (ratchet) | **error** | — |
| drift | — | info | per config | — |
| spec-lint errors (schema, DAG) | **error** | **error** | **error** | warning |

- `ready` requires all `depends_on` to exist; `in-progress` requires them to be **satisfied** (status `implemented` and passing), unless `--force`.
- `implemented` can only be set when the spec's enforceable contracts pass (CLI and MCP enforce this).

---

## 9. Claims (runtime locks) — F-10

Store: `<git-common-dir>/catspec/claims/`, shared by all worktrees of the clone.

```json
{ "spec": "user-sync-handler", "owner": "agent:claude-1", "worktree": "/repo/.worktrees/user-sync-handler",
  "branch": "spec/user-sync-handler", "scope": ["src/Services/Identity/Handlers/**", "…resolved files"],
  "acquiredAt": "…", "heartbeatAt": "…", "ttl": "4h" }
```

- **Acquire** is atomic: write a temp file, then `link()`/`open(O_CREAT|O_EXCL)` the claim name; a global `claims.lock` mutex (same technique) guards the scope-overlap check so two overlapping claims cannot be taken concurrently.
- **Overlap**: scope globs and resolved files are compared; any intersection with another live claim → refused (`CS0500`), listing the holder.
- **Lease**: `heartbeatAt + ttl` < now → stale; `catspec claim --steal` or automatic reclaim with a warning.
- **Owner identity**: worktree path → claim lookup, else `CATSPEC_AGENT_ID`, else `user:<git user.email>`.
- **Enforcement**: in the pre-commit hook, staged paths that fall in another owner's live claim → error `CS0501`.
- Interface `ClaimStore` (`acquire/release/heartbeat/list`) allows a later git-refs or HTTP backend.

---

## 10. CLI — `catspec`

Global flags: `--cwd`, `--config`, `--format text|json`, `--no-color`, `--quiet`, `--verbose`.
Exit codes: `0` ok/warnings only, `1` errors found, `2` usage/config error, `3` internal error.

| Command | Description |
|---|---|
| `catspec init [--hooks] [--agents]` | create `catspec.yaml`, `docs/spec/`, `guidelines/architecture/ADR.md` and an example feature folder (§3); optionally install hooks and add layout rules to `AGENTS.md` |
| `catspec lint` | validate spec files only: schema, ids, DAG, references, queries |
| `catspec check [paths…] [--staged] [--spec <id>…] [--run-tests]` | full validation (lint + contracts + drift + claims); `--staged` reads the index |
| `catspec verify <spec-id>` | check one spec, print agent-friendly report; exit code = done/not-done |
| `catspec list [--status s] [--ready]` | list specs; `--ready` = deps satisfied and unclaimed |
| `catspec show <spec-id>` | normalised model + compliance + deps + claim |
| `catspec graph [--format mermaid\|dot\|json] [--focus id]` | DAG export |
| `catspec sync [--apply] [--staged]` | detect renames/moves (§11.4) and propose / apply location edits |
| `catspec accept <spec-id>` | record current shapes as accepted (drift baseline) |
| `catspec status <spec-id> <status> [--force]` | lifecycle transition with rule checks (§8) |
| `catspec bind <symbol> --spec <id> [--file f]` | scaffold a binding from existing code (shape copied as contract) |
| `catspec lock [--rebuild]` | (re)generate lock files |
| `catspec claim <spec-id> [--owner o] [--steal]` / `release <spec-id>` / `claims` | runtime locks |
| `catspec assign <spec-id> [--owner o] [--worktree path]` | check deps → claim → `git worktree add -b spec/<id>` → write `.catspec-context.md` into the worktree |
| `catspec install-hooks [--manager auto\|git\|husky\|lefthook]` / `uninstall-hooks` | |
| `catspec mcp` | start MCP server on stdio |
| `catspec coverage` | contract satisfaction, enforcement coverage, reverse code coverage (F-3) |

Text output example:

```
✖ user-sync-handler  docs/spec/user-sync/user-sync-handler.spec.md:12
  CS0204 Binding 'handler' (Identity.Handlers.UserUpdatedHandler) does not implement IMessageHandler<UserUpdatedEvent>
         found: class UserUpdatedHandler : IHandler   src/Services/Identity/Handlers/UserUpdatedHandler.cs:8:14
  CS0203 Member 'HandleAsync' missing; did you mean 'HandleUserAsync'? (:21:23)
✔ cdc-core-events
2 errors, 0 warnings in 2 specs (318 ms)
```

---

## 11. Engine design

### 11.1 Packages (npm workspaces, TypeScript, Node ≥ 20, ESM)

| Package | Responsibility | Depends on |
|---|---|---|
| `@catspec/core` | spec model, schema, parser, CST editor, DAG, config, rule engine, diagnostics, lock files, claims, git access; **defines** the `LanguageAdapter` / `FileFacts` types (§11.2) | `yaml`, `zod`, `remark-parse`, `picomatch` |
| `@catspec/lang` | Tree-sitter (WASM) loader, query runner, symbol normaliser, parse cache | core, `web-tree-sitter` |
| `@catspec/lang-typescript` | TS/TSX adapter + `.scm` queries + grammar WASM | `@catspec/lang` |
| `@catspec/lang-csharp` | C# adapter | `@catspec/lang` |
| `@catspec/cli` | `catspec` binary, reporters | core, lang-* |
| `@catspec/mcp` | MCP server | core, lang-*, `@modelcontextprotocol/sdk` |

Dependency direction: `core ← lang ← lang-* ← cli / mcp`. `core` never imports
Tree-sitter or any adapter; `cli` and `mcp` inject the adapters into the engine
(ADR-003 in `guidelines/architecture/ADR.md`).

`catspec` (unscoped) is the meta-package that installs CLI + MCP + default adapters,
so `npx catspec init` works. WASM grammars avoid native build failures (decision: portability over raw speed).

### 11.2 Language adapter interface

```ts
interface LanguageAdapter {
  id: 'typescript' | 'csharp' | string;
  extensions: string[];
  load(): Promise<void>;                              // load grammar wasm + compile queries
  extract(file: SourceFile): FileFacts;               // pure, cacheable by blob sha
  normalizeType(text: string): TypeRef;               // language-specific normalisation
  qualify(symbol: SymbolFact, file: SourceFile): string; // qualified name
}

interface FileFacts {
  path: string; blobSha: string; lang: string;
  symbols: SymbolFact[];        // top-level and nested declarations
  imports: ImportFact[];        // module specifier, imported names, range
  calls: CallFact[];            // callee text, enclosing symbol id, range
  parseErrors: Range[];         // tree-sitter ERROR nodes
}

interface SymbolFact {
  id: string;                   // `${path}#${qualifiedName}` (+ `(${arity})` for overloads)
  name: string; qualifiedName: string;
  kind: SymbolKind; range: Range; nameRange: Range;
  modifiers: string[]; attributes: AttributeFact[];
  bases: TypeRef[]; typeParams: string[];
  params?: ParamFact[]; returns?: TypeRef;
  members: SymbolFact[];
  partial?: boolean; exported?: boolean;
  bodyTokens?: string[];        // for rename similarity only (not persisted in lock)
}
```

Rules operate **only** on `FileFacts`, never on raw trees (except `query` rules), so
the rule engine is language-agnostic and testable without grammars.

### 11.3 Check pipeline

```
load config ─► discover specs (index or disk) ─► parse frontmatter (yaml CST) + body (mdast)
   ─► schema validate ─► build DAG (cycles, unknown ids) ─► compile rules/queries
   ─► compute file set: binding hints ∪ scope ∪ changed files (staged) ∪ arch-rule scope
   ─► FileFacts for each (cache by blob sha) ─► resolve bindings (§11.5)
   ─► evaluate contracts + rules ─► apply status matrix + ratchet + waivers
   ─► drift vs lock fingerprints ─► claims enforcement ─► diagnostics ─► reporter / exit code
   ─► (hook) update lock files (+ re-stage if configured)
```

Source reading: `SourceProvider` interface with `WorkingTreeProvider` and
`IndexProvider` (`git ls-files -s -z` + `git cat-file --batch`), F-9.

### 11.4 Rename / move detection (F-7)

Triggered when a previously resolved binding (lock file `resolved`) no longer resolves:

1. **Moved**: same qualified name found elsewhere (reverse index / search) → location edit, score 1.0.
2. **File renamed**: `git diff -M --name-status` (staged or HEAD..worktree) maps old → new path; search there.
3. **Symbol renamed**: candidates = symbols of same kind present now but absent at the previous revision in the old/new file. `score = 0.5·jaccard(memberNames) + 0.4·tokenSimilarity(body) + 0.1·sameFile`.
4. Unique candidate with score ≥ `heal.threshold` → `CS0210 renamed` with patch; `heal.mode=auto` applies it via CST and re-stages the spec. Ambiguous → list candidates, no edit.

Body references to the old name in the Markdown (`` `OldName` ``) are reported as `info` with locations, not rewritten.

### 11.5 Binding resolution

1. Expand `file` hint (glob) within the language include set; collect symbols whose qualified name ends with `symbol` (segment-wise suffix match).
2. If none: lock file `resolved` path; then repo-wide search (lazy symbol index of the language's include set).
3. 0 matches → `CS0201 not found` (+ did-you-mean via Damerau-Levenshtein over same-kind names, ≤ 3 suggestions). >1 non-partial match → `CS0202 ambiguous`. C# `partial` matches → merged.

### 11.6 Spec editing (CST)

All writes (heal, `bind`, `status`, `accept`, MCP) use `yaml`'s `Document` API on the
frontmatter only, preserving comments, key order, quoting and the Markdown body byte-for-byte.
Golden round-trip tests guarantee `parse → no-op edit → write` is identity.

### 11.7 Performance (F-16)

- Parse cache: `<git-common-dir>/catspec/cache/<lang>/<blob-sha>.json` (FileFacts minus `bodyTokens`), versioned by adapter+grammar version.
- Staged mode parses only staged files + files of bindings whose specs or files changed.
- Budgets (asserted in a benchmark job): staged ≤ 1 s, full cold ≤ 10 s on a 10k-file synthetic repo.

---

## 12. Diagnostics

```ts
interface Diagnostic {
  code: string;            // CSxxxx, stable
  severity: 'error' | 'warning' | 'info';
  spec?: string;           // spec id
  specLocation?: Location; // file:line:col of the binding/rule in frontmatter
  codeLocation?: Location;
  message: string;         // human sentence, includes expected vs found
  expected?: unknown; actual?: unknown;
  suggestions?: { message: string; patch?: SpecPatch }[];
  ruleId?: string; bindingId?: string;
}
```

| Range | Area | Examples |
|---|---|---|
| CS01xx | spec lint | 0101 invalid schema, 0102 unknown key, 0103 duplicate id, 0104 unknown dependency, 0105 cycle, 0106 spec outside feature folder, 0110 unknown ref in body, 0111 unenforced prose, 0112 unknown ADR id, 0130 invalid query |
| CS02xx | bindings | 0201 not found, 0202 ambiguous, 0203 member missing, 0204 base missing, 0205 signature mismatch, 0206 attribute missing, 0207 ctor dependency missing, 0208 visibility/export, 0210 renamed (heal), 0220 unresolvable (syntactic limit) |
| CS03xx | drift / ratchet | 0300 drift, 0301 regression of satisfied item |
| CS04xx | waivers | 0400 waived, 0401 expired |
| CS05xx | claims / DAG gate | 0500 claim conflict, 0501 commit touches foreign claim, 0502 deps not satisfied |
| CS06xx | rules | 0601 forbidden call, 0602 required call missing, 0603 forbidden import, 0604 naming, 0605 must-not-exist, 0610 query match, 0620 test symbol missing, 0621 test failed |
| CS09xx | engine | 0901 parse error in file (partial results), 0902 git unavailable |

---

## 13. Git hook (pre-commit)

Installed script (POSIX sh, also works under Git for Windows):

```sh
#!/bin/sh
# catspec-managed
exec npx --no-install catspec check --staged --format text
```

- Installer detects `core.hooksPath`, husky (`.husky/`), lefthook (`lefthook.yml`) and adds an entry instead of overwriting; refuses to overwrite a foreign hook without `--force` (backs it up and chains it).
- Behaviour: exits non-zero on errors; prints the fix path (`catspec sync --apply`, `catspec accept`, edit spec).
- Escape hatch `CATSPEC_SKIP=1` (logged as a warning in the next run) in addition to `--no-verify`.

---

## 14. MCP server (`catspec mcp`, stdio)

Built on `@modelcontextprotocol/sdk`. Every tool returns both a short text summary
and `structuredContent` (JSON) with diagnostics. Paths are resolved against the repo
root; anything outside → error.

### 14.1 Tools

| Tool | Input | Output / behaviour |
|---|---|---|
| `list_specs` | `status?`, `ready_only?` | id, title, status, deps satisfied?, claim, progress |
| `get_spec_context` | `spec_id` | Markdown body, normalised contract (bindings, members, rules by class), dependency status, infrastructure, claim, **current compliance** and resolved file paths, architecture rules that apply |
| `verify_compliance` | `spec_id?`, `file_path?`, `staged?` | runs check for the spec, or for all specs bound to the file; diagnostics with expected/actual/suggestions; `done: boolean` |
| `find_specs_for_file` | `file_path` | specs binding/scoping that file |
| `check_dependencies` | `spec_id` | each dependency with status, satisfaction, failing items |
| `claim_spec` / `release_spec` | `spec_id`, `owner?` | §9; returns scope or conflict holder |
| `update_spec_bindings` | `spec_id`, `patch` (JSON-merge on bindings), `dry_run=true` | returns unified diff; location edits applied if allowed; contract edits applied only if `mcp.allow_contract_edits` else returned as proposal (F-13) |
| `set_spec_status` | `spec_id`, `status`, `links?` (`pr`, `commit`) | lifecycle rules (§8); `implemented` refused if contracts fail (replaces `mark_spec_resolved`) |

### 14.2 Resources & prompts

- Resources: `catspec://spec/{id}` (raw file), `catspec://architecture`, `catspec://graph` (mermaid), `catspec://diagnostics` (last check).
- Prompts: `implement-spec(spec_id)` — workflow: get context → claim → implement → verify until `done` → set status; `fix-drift(spec_id)`.

### 14.3 Agent "definition of done" (F-18)

Documented recipe for Claude Code: a `Stop` hook running
`catspec verify <id> --format json` and returning the diagnostics to the agent
when not done; plus the MCP server registered via `claude mcp add catspec -- npx catspec mcp`.

---

## 15. Non-functional requirements

| Area | Requirement |
|---|---|
| Platforms | Linux, macOS, Windows; Node ≥ 20; git ≥ 2.30 |
| Install | `npm i -D catspec` or `npx catspec`; no native compilation |
| Determinism | same input → byte-identical output and lock files |
| Robustness | files with parse errors give partial facts + `CS0901`, never a crash |
| Security | no network; MCP restricted to repo root; no code execution except `--run-tests` with configured command |
| Quality | ≥ 90 % line coverage in `core`; golden tests per adapter; CST round-trip tests |
| Docs | README quick start, spec format reference, rule catalogue, diagnostics reference, agent integration guide |
| Licence | Apache-2.0 (as in repo) |

## 16. Acceptance scenarios (MVP)

1. **Rename blocked**: an `implemented` spec binds `AuthService.validateToken`; renaming it to `checkToken` and committing fails with `CS0203` + did-you-mean.
2. **Rename healed**: renaming class `UserHandler`→`UserUpdatedHandler` with `heal.mode=suggest` fails with `CS0210` and a patch; `catspec sync --apply` fixes the spec and the next commit passes.
3. **Move tolerated**: moving the file to another folder without renaming passes (symbol-first binding).
4. **In-progress ratchet**: a missing method in an `in-progress` spec is a warning; after it is implemented and committed, deleting it is an error.
5. **Partial staging**: a staged correct version + unstaged broken version passes; the reverse fails.
6. **Architecture rule**: `src/Domain/**` importing `src/Infrastructure/**` fails with `CS0603`.
7. **DAG**: `assign user-sync-handler` refuses while `cdc-core-events` is not `implemented`.
8. **Claims**: two agents claiming overlapping specs — second gets `CS0500`; committing into a foreign claim's files fails with `CS0501`.
9. **MCP loop**: agent calls `get_spec_context`, writes code with `signIn`, `verify_compliance` returns `CS0203 expected login, found signIn`, agent fixes, verify returns `done: true`, `set_spec_status implemented` succeeds.
10. **Agent can't weaken contract**: `update_spec_bindings` removing a member returns a proposal and does not write when `allow_contract_edits=false`.
