<p align="center">
  <img src=".github/assets/catspec-logo.svg" alt="CatSpec logo: a cat on a laptop" width="160">
</p>

# CatSpec

**Specs that check the code.** CatSpec links your Markdown specs to real classes and methods,
checks them on every commit, and lets AI agents verify their own work before they say "done".

> **Version 0.2.** TypeScript and C#, on Linux, macOS and Windows (Node.js 22.12+). Read the
> [user guide](docs/spec/catspec-user-guide/spec.md): [quick start](docs/spec/catspec-user-guide/quick-start.md) ·
> [spec format](docs/spec/catspec-user-guide/spec-format.md) ·
> [rules](docs/spec/catspec-user-guide/rules.md) ·
> [diagnostics](docs/spec/catspec-user-guide/diagnostics.md) ·
> [commands](docs/spec/catspec-user-guide/commands.md) ·
> [agents](docs/spec/catspec-user-guide/agents.md) ·
> [workflows](docs/spec/catspec-user-guide/workflow-presets.md) ·
> [FAQ and limits](docs/spec/catspec-user-guide/faq.md). Examples:
> [`examples/ts-auth-service`](examples/ts-auth-service/) and
> [`examples/dotnet-user-sync`](examples/dotnet-user-sync/).

---

## Get started

1. **Install and set up** in your repository:

   ```bash
   npm install -g catspec
   catspec init --hooks --agents --with-adr
   ```

   `init` always writes `catspec.yaml`. Each option adds one thing (see [`init` options](#init-options)):
   `--hooks` the git pre-commit check, `--agents` the setup for AI agents, `--with-adr` a file for
   [repository-wide rules](#repository-wide-rules-optional-adr-file) (optional). On Windows
   PowerShell, use `catspec.cmd` and `npm.cmd`.
2. **Connect your AI agent:** `claude mcp add catspec -- npx catspec mcp` for Claude Code; Codex,
   Cursor, Copilot and other agents in
   [agent integration](docs/spec/catspec-user-guide/agents.md). Then ask it how to do something
   with CatSpec: it reads the user guide through the MCP server.
3. **Write your first spec:** in `docs/spec/<your-feature>/`, write `<spec-id>.spec.md` and bind it
   to one of your classes ([spec format](docs/spec/catspec-user-guide/spec-format.md)).
   `catspec init --with-sdd-example` writes a complete example to copy from.
4. **Check:** `catspec check`. Every problem has a code and a hint, and
   `catspec guide diagnostics` explains each code.
5. **Commit.** The pre-commit hook stops commits that break a contract that already passed.

The whole guide is also in your terminal: `catspec guide` lists the pages and
`catspec guide <page>` prints one.

**To remove CatSpec**, run `catspec uninstall` in the repository *before* `npm uninstall -g catspec`
(or `npm uninstall catspec` for a project install). npm can't clean up after a package, so the
pre-commit hook stays in the repository until `catspec uninstall` removes it. Add `--files` to also
delete `catspec.yaml` and the example files `init` wrote. If CatSpec is already gone, remove the hook
by hand: delete `.git/hooks/pre-commit` (or `pre-commit` in the folder `git config core.hooksPath`
names) and rename `pre-commit.catspec-backup`, if it is there, back to `pre-commit`. With husky,
delete the `catspec-managed` block from `.husky/pre-commit`; with lefthook, delete the `catspec`
command from `lefthook.yml` and run `lefthook install`.

---

## Why

In spec-driven development (OpenSpec, Spec Kit, custom skills) the spec is just text. An agent
reads it, writes code and says it's done, and nothing checks that. A month later someone renames
a method and the spec is quietly wrong.

CatSpec turns the checkable part of a spec into **contracts**:

- *"class `AuthService` exists and has `login`, `logout`, `validateToken`"*
- *"`UserUpdatedHandler` implements `IMessageHandler<UserUpdatedEvent>`"*
- *"`src/Domain/**` must not import `src/Infrastructure/**`"*

It checks them against the code's syntax tree (via Tree-sitter, with no compiler needed), and:

| Where | What CatSpec does |
|---|---|
| **Your agent** (Claude Code, Cursor, Windsurf) | tells it what to build, checks its work, and won't let it stop while checks fail |
| **Every commit** (pre-commit hook) | blocks commits that break a contract that already passed |
| **Renames** | finds renamed or moved classes and updates the specs for you |
| **Your workflow** | plugs into OpenSpec, Spec Kit or your own skills, without replacing them |

CatSpec never writes specs or code itself, and it never calls an AI. Your agent does the
creative work; CatSpec checks the result. Checks give the same answer every time.

Languages in v0.1: **TypeScript** and **C#**.

---

## Install

```bash
npm install -g catspec
catspec init --hooks --agents --with-adr
```

A global install gives you the `catspec` command in every repository. To pin one version for the
whole team instead, use `npm install --save-dev catspec` and run the commands as `npx catspec …`.

### `init` options

`catspec init` always writes `catspec.yaml`, the config, and never overwrites a file that exists.
Run it again any time to add an option you left out.

| Option | What it adds | What it is for |
|---|---|---|
| `--hooks` | a git pre-commit hook (`.git/hooks/pre-commit`; works with husky and lefthook too) | runs `catspec check --staged` on every commit and stops a commit that breaks a contract that already passed |
| `--agents` | a CatSpec block in `AGENTS.md` and a Stop hook in `.claude/settings.json` (your own content is kept) | tells AI agents the workflow, and doesn't let Claude Code finish while its spec still fails (see [Use it with an AI agent](#use-it-with-an-ai-agent)) |
| `--with-adr` | `docs/architecture/adr/<name>-adr.md`, or `architecture-rules.md` in the ADR folder you already have | optional: a place for rules that CatSpec checks over the whole repository (see [Repository-wide rules](#repository-wide-rules-optional-adr-file)) |
| `--with-sdd-example` | an example feature in `docs/spec/example-feature/` | a complete spec to read and copy from |
| `--preset <name>` | the `workflow:` section of `catspec.yaml` | picks the spec-driven workflow CatSpec checks: `catspec`, `openspec`, `spec-kit` or `custom`. Without it, `init` detects it |
| `--name <name>` | the name of the `--with-adr` file (`<name>-adr.md`) | defaults to the repository folder name |

What you get:

```
catspec.yaml                               # config (always)
.git/hooks/pre-commit                      # with --hooks
AGENTS.md block + .claude/settings.json    # with --agents
docs/architecture/adr/<name>-adr.md        # with --with-adr
docs/spec/example-feature/                 # with --with-sdd-example
docs/spec/<feature>/                       # your features, one folder each:
  spec.md  plan.md                         #   your human docs
  <spec-id>.spec.md                        #   machine-checkable specs
```

If your repo already uses OpenSpec, Spec Kit or `sdd-*` skills, `init` detects it and suggests the
matching workflow preset.

---

## Write a spec

A spec is Markdown with a YAML header. The header is what CatSpec checks; the body is for people
and agents.

`docs/spec/user-auth/user-auth-service.spec.md`:

```markdown
---
catspec: 1
id: user-auth-service
type: feature
status: ready
depends_on: [database-schema]
bindings:
  - id: auth
    symbol: AuthService
    kind: class
    file: src/services/AuthService.ts        # a hint; moving the file doesn't break the spec
    members:
      - login
      - logout
      - name: validateToken
        params: [string]
        returns: "Promise<boolean>"
rules:
  - id: no-console
    class: structural
    forbid_call: "console.*"
    within: auth
---

# User authentication service

## Contracts
- [binding:auth] `AuthService` provides login, logout and token validation.
- [rule:no-console] No direct console logging; use `IAuthLogger`.

## Tasks
- [ ] Scaffold `AuthService`
- [ ] Implement JWT validation
```

For code that already exists, `catspec bind AuthService --spec user-auth-service` writes the
binding for you.

---

## Repository-wide rules (optional ADR file)

You don't need an ADR file to use CatSpec. Specs, contracts, lock files, the hook, workflows and
the MCP server all work without one, and your agents keep reading your architecture from
`AGENTS.md` or your guidelines as before.

CatSpec never reads the text of your decisions. What it can read from an ADR file is **rules in
its frontmatter**, which it checks over every source file on every `catspec check` and commit.
Add one if you want rules like these to be enforced, not just written down:

```yaml
---
catspec: 1
id: architecture
type: architecture
status: implemented   # draft = written down but not enforced yet
rules:
  - id: domain-is-pure            # the domain layer never imports infrastructure
    class: structural
    adr: ADR-003                  # optional: the decision this rule enforces
    forbid_import:
      from: "src/domain/**"
      to: ["src/infrastructure/**"]
  - id: no-console                # no console.* calls in shipped code
    class: structural
    forbid_call: "console.*"
    paths: ["src/**"]
  - id: handlers-in-place         # classes named *Handler live in src/handlers/
    class: structural
    naming: { kind: class, name: "*Handler", in_path: "src/handlers/**" }
---

# Architecture Decision Records

## ADR-003: The domain layer has no infrastructure dependencies
```

A rule that one feature needs can live in that feature's `*.spec.md` instead; it is then checked
only on that feature's code. The [rule catalogue](docs/spec/catspec-user-guide/rules.md) lists
every rule type.

**To add the file:**

- No ADRs yet: `catspec init --with-adr` writes `docs/architecture/adr/<name>-adr.md` with the
  frontmatter above and an empty `rules: []`.
- ADRs in a folder already (`docs/adr/0001-use-postgres.md`, …): point `catspec.yaml` at it.
  `init` does this for you when it finds `docs/adr/`, `docs/decisions/` or another common folder.

  ```yaml
  specs:
    architecture: "docs/adr"   # a folder, a file or a glob
  ```

  Your ADR files stay as they are: CatSpec only reads their ids (`0007-….md` is ADR-007), so a
  rule can say `adr: ADR-007`. Put the rules in one file in that folder with the frontmatter
  above; `catspec init --with-adr` writes it as `docs/adr/architecture-rules.md`.

---

## Run it manually

```bash
catspec check                          # check everything: specs, contracts, drift
catspec check --spec user-auth-service # one spec, with a fix list ending in DONE / NOT DONE
catspec check --specs-only             # only the spec files (format, ids, dependencies), fast
catspec list --ready                   # specs whose dependencies are done
catspec graph --format mermaid         # dependency graph
catspec coverage                       # how much of the specs is actually enforced and passing
```

Example output:

```
✖ user-auth-service  docs/spec/user-auth/user-auth-service.spec.md:12
  CS0203 Member 'validateToken' missing in AuthService; did you mean 'checkToken'?
         src/services/AuthService.ts:21:3
1 error in 1 spec (204 ms)
```

**Status and lifecycle.** `draft → ready → in-progress → implemented → deprecated`

```bash
catspec status user-auth-service in-progress   # refused while depends_on aren't implemented
catspec status user-auth-service implemented   # refused while any contract fails
```

How strict the commit hook is depends on the status:
- **in-progress** specs only warn about unfinished parts. Breaking something that already passed is an error.
- **implemented** specs are fully enforced.

**Renames and refactoring**

```bash
catspec sync                 # show detected renames / moves and the spec edits they need
catspec sync --apply         # apply them

catspec refactor --scope "src/accounts/**"   # before a big refactor: take a snapshot
# … rename / move many classes in your IDE …
catspec sync --apply                          # map all old → new names at once, end the refactor
catspec refactor status | abort
```

**Intentional signature changes:** `catspec accept <spec-id>`. To rebuild all lock files:
`catspec baseline --rebuild`.

---

## Use it with an AI agent

The goal is that **the developer doesn't type `catspec` commands**: the agent runs them, and hooks
make sure it doesn't skip any.

### 1. Connect the MCP server

```bash
claude mcp add catspec -- npx catspec mcp      # Claude Code, from the repository folder
```

Other clients start the same command. Give the repository with `--cwd`, since they don't start it
in the project folder:

| Client | Config file | Entry under `mcpServers` |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | `"catspec": { "command": "npx", "args": ["catspec", "--cwd", "/path/to/repo", "mcp"] }` |
| Cursor | `.cursor/mcp.json` in the repository | `"catspec": { "command": "npx", "args": ["catspec", "--cwd", "${workspaceFolder}", "mcp"] }` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `"catspec": { "command": "npx", "args": ["catspec", "--cwd", "/path/to/repo", "mcp"] }` |

Codex reads `~/.codex/config.toml` and starts the CatSpec installed in the repository with `node`
(on Windows, Codex can't start `npx`):

```toml
[mcp_servers.catspec]
command = "node"
args = ["/path/to/repo/node_modules/catspec/dist/bin.js", "--cwd", "/path/to/repo", "mcp"]
```

Then restart Codex. Windows paths and how to see why a server doesn't start:
[agent integration](docs/spec/catspec-user-guide/agents.md).

The agent gets tools such as `get_spec_context`, `check_compliance`, `next_step`,
`start_stage` and `finish_stage`.

### 2. Tell the agent the rules, once

`catspec init --agents` adds this block to `AGENTS.md` (Claude Code reads it via `CLAUDE.md`):

```markdown
<!-- catspec:begin -->
## CatSpec workflow (agents must follow)
For every work item (PBI) `<id>` you work on:
1. Before coding run `catspec stage start task <id>`. If it fails, stop and report why.
2. After each change run `catspec check --spec <id>` and fix everything it reports, until it says DONE.
3. When all tasks in `<id>.spec.md` are ticked, run `catspec stage finish task <id>`,
   then `catspec stage finish close <id>`.
4. Never weaken a contract in a `*.spec.md` to make a check pass. Ask the developer instead.
<!-- catspec:end -->
```

You write this once, not in every `tasks.md`.

### 3. Make it reliable with hooks

Agents usually follow instructions, but not always. Two hooks close the gap:

| Hook | Runs | Effect |
|---|---|---|
| Claude Code `Stop` hook | `catspec check --in-progress --format agent` | while an in-progress item fails, the agent can't finish its turn and gets the fix list |
| git pre-commit | `catspec check --staged` | no commit can break a contract |

`init --agents` merges the Stop hook into `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "npx catspec --cwd \"$CLAUDE_PROJECT_DIR\" check --in-progress --format agent" } ] }
    ]
  }
}
```

If the agent fails 3 times in a row with the same errors, CatSpec lets it stop and tells you the
item is stuck, so it can't loop forever.

### What a session looks like

```
you:    /sdd-task register-api
agent:  catspec stage start task register-api      → dependencies OK, status in-progress
agent:  (writes code) → catspec check --spec register-api
        ✖ CS0203 expected method 'login', found 'signIn'
agent:  (renames) → catspec check --spec register-api → DONE
agent:  catspec stage finish task register-api      → passes
agent:  catspec stage finish close register-api     → tasks ticked, no drift → implemented
agent:  "register-api is done."                     → Stop hook: check passes, agent may stop
you:    review the diff, commit                      → pre-commit hook: passes
```

---

## Plug into your SDD workflow

Tell CatSpec how your repo plans work, in `catspec.yaml`. CatSpec then knows the steps, tells the
agent what's next, and checks each step when it starts and finishes.

**OpenSpec or Spec Kit:** one line.

```yaml
workflow:
  preset: openspec      # or: spec-kit
```

**Your own skills** (example: `sdd-spec`, `sdd-plan`, `sdd-task`, `sdd-close`):

```yaml
workflow:
  preset: custom
  feature_dir: "docs/spec/{feature}"
  skills_dir: ".claude/skills"
  stages:
    - id: spec                       # once per epic
      per: feature
      driver: { skill: sdd-spec }
      produces: ["{feature_dir}/spec.md", "{feature_dir}/*.spec.md"]
      finish: { gates: [specs_valid, artifacts, contracts_declared] }
    - id: plan
      per: feature
      driver: { skill: sdd-plan }
      produces: ["{feature_dir}/plan.md"]
      finish: { gates: [artifacts, deps_known], status: ready }
    - id: task                       # once per PBI
      per: spec
      driver: { skill: sdd-task }
      start:  { gates: [deps_ready], status: in-progress }
      finish: { gates: [contracts_pass] }
    - id: close
      per: spec
      driver: { skill: sdd-close }
      finish: { gates: [contracts_pass, tasks_done, no_drift], status: implemented }
```

```bash
catspec workflow doctor            # are the skills there? does the config match the repo?
catspec workflow show [feature]    # where each feature / PBI is
catspec workflow snippet task      # the 2 lines to paste into your sdd-task skill
catspec next <feature>             # what to do next, and with which skill
```

With `preset: openspec` the stages are `proposal`, `apply` and `archive`, driven by OpenSpec's
`/opsx:propose`, `/opsx:apply` and `/opsx:archive`. With `preset: spec-kit` they are `specify`,
`plan`, `tasks` and `implement` (`/speckit.*`).

If a gate blocks a step and you know why, `catspec stage start|finish … --force` goes ahead with a
warning and logs the override in `.git/catspec/workflow-overrides.log`. It still never marks a spec
`implemented` while its contracts fail, and agents can't force a step over MCP.

### Example: an epic with features, PBIs and tasks

```
docs/spec/user-account-management/            # epic
  spec.md  plan.md
  registration.spec.md        # feature: groups PBIs   depends_on: [register-api, email-verification]
  register-api.spec.md        # PBI (its tasks are the "## Tasks" checklist inside)
  email-verification.spec.md  # PBI   depends_on: [register-api]
  login.spec.md               # feature                depends_on: [login-api, token-refresh]
  login-api.spec.md           # PBI   depends_on: [register-api]
  token-refresh.spec.md       # PBI   depends_on: [login-api]
```

```bash
# Epic: spec and plan (run by /sdd-spec and /sdd-plan)
catspec stage start  spec user-account-management
catspec stage finish spec user-account-management    # specs valid, files exist
catspec stage start  plan user-account-management
catspec stage finish plan user-account-management    # → all specs "ready"

# Which PBI can start?
catspec next user-account-management                 # → register-api (others wait on it)

# Each PBI (run by /sdd-task and /sdd-close, or by the agent per AGENTS.md)
catspec stage start  task  register-api              # → in-progress
catspec check --spec register-api                    # repeat until DONE
catspec stage finish task  register-api
catspec stage finish close register-api              # → implemented
# now email-verification and login-api are ready (they can run in parallel, on two branches)

# Features, then the epic
catspec stage finish close registration              # passes once both its PBIs are implemented
catspec stage finish close login
catspec stage finish close user-account-management   # re-checks every spec; the epic is done
```

---

## Command reference (v0.1)

Every command and option: [command reference](docs/spec/catspec-user-guide/commands.md).

| Command | Purpose |
|---|---|
| `init [--preset p] [--hooks] [--agents]` | set up the repo |
| `install-hooks` / `uninstall-hooks` | git pre-commit hook (husky / lefthook aware) |
| `mcp` | start the MCP server for agents |
| `check [paths] [--spec id] [--specs-only] [--staged] [--in-progress] [--format text\|json\|agent]` | the one validation command |
| `list [--status s] [--ready]` · `show <spec>` · `graph` · `coverage` | inspect specs and progress |
| `bind <symbol> --spec <id>` | create a binding from existing code |
| `status <spec> <status> [--force]` | change lifecycle status (with checks) |
| `accept <spec>` · `baseline --rebuild` | accept intentional signature changes · rebuild lock files |
| `sync [--apply] [--map f]` | fix spec locations after renames / moves |
| `refactor [--scope g]` · `refactor status` · `refactor abort` | large refactors |
| `next <feature>` · `stage start\|finish <stage> <feature\|spec> [--force]` | workflow steps |
| `workflow show\|doctor\|snippet` | workflow profile tools |

Exit codes: `0` ok, `1` errors, `2` usage or config error, `3` internal error. With `--format agent`:
`0` done, `2` not done (blocks the agent), `1` error.

---

## Limits (v0.1)

- **Structure, not behaviour.** CatSpec checks names, members, signatures, interfaces, imports and
  calls. Behaviour ("must be idempotent") needs a linked test, or stays a tracked `manual` invariant.
- **Syntax only.** No type resolution across files: inheritance chains and aliases aren't followed.
  When something can't be decided, CatSpec says so instead of guessing.
- **No agent locks.** Parallel agents use git branches; `catspec check` after a merge catches broken
  contracts. Locks are planned for later (ADR-014).
- **Local only.** CI integration (SARIF, PR comments) and the GitHub App come after v0.1.
- **Big files.** Files over 1 MiB aren't parsed (one CS0901 warning).

More in the [FAQ](docs/spec/catspec-user-guide/faq.md).

---

## Contributing

This repo is developed spec-first. Read [`AGENTS.md`](AGENTS.md) for where docs and decisions live,
the [ADR log](docs/architecture/adr/reactive-ast-adr.md) for architecture decisions, and the
design documents: [analysis](docs/spec/reactive-ast-linked-spec-engine/analysis.md) ·
[spec](docs/spec/reactive-ast-linked-spec-engine/spec.md) ·
[plan](docs/spec/reactive-ast-linked-spec-engine/plan.md) ·
[features](docs/spec/reactive-ast-linked-spec-engine/features/).

## License

[Apache-2.0](LICENSE)
