# Agent integration

The goal: the developer doesn't type `catspec` commands. The agent runs them, and two hooks make
sure it can't skip them. The full design is in
[plan §D14](../reactive-ast-linked-spec-engine/plan.md#d14-mcp-server-catspec-mcp-stdio).

```bash
npx catspec init --agents        # in an existing repository: the AGENTS.md block + the Stop hook
```

## 1. The MCP server

```bash
claude mcp add catspec -- npx catspec mcp      # Claude Code, from the repository folder
```

Other clients start the same command and pass the repository with `--cwd`:

| Client | Config file | Entry under `mcpServers` |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | `"catspec": { "command": "npx", "args": ["catspec", "--cwd", "/path/to/repo", "mcp"] }` |
| Cursor | `.cursor/mcp.json` | `"catspec": { "command": "npx", "args": ["catspec", "--cwd", "${workspaceFolder}", "mcp"] }` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `"catspec": { "command": "npx", "args": ["catspec", "--cwd", "/path/to/repo", "mcp"] }` |

Tools:

| Tool | What it does |
|---|---|
| `list_specs` | specs with status, progress, and whether their dependencies are done |
| `get_spec_context` | everything an agent needs to implement a spec: body, contract, dependencies, current compliance, files, architecture rules |
| `check_compliance` | the check for a spec or a file, with expected, found and fix; `done: true` when it passes |
| `find_specs_for_file` | the specs that bind or scope a file |
| `check_dependencies` | each dependency's status and failing items |
| `update_spec_bindings` | location edits (applied when allowed); contract edits only as a proposal unless `mcp.allow_contract_edits: true` |
| `start_refactor`, `sync_specs` | the large-refactor flow of `catspec refactor` and `catspec sync` |
| `next_step`, `start_stage`, `finish_stage` | the workflow steps (`catspec next`, `catspec stage`); no `--force` over MCP |
| `set_spec_status` | lifecycle changes; `implemented` is refused while contracts fail |

Resources: `catspec://spec/{id}`, `catspec://architecture`, `catspec://graph`,
`catspec://diagnostics`. Prompts: `implement-spec`, `fix-drift`, and one `stage-<id>` prompt per
workflow stage. The server only reads and writes inside the repository.

## 2. The rules, once, in `AGENTS.md`

`init --agents` adds this block (Claude Code reads it through `CLAUDE.md`);
`catspec workflow snippet agents` prints it:

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

The block follows the workflow preset's stage names.

## 3. The hooks

| Hook | Runs | Effect |
|---|---|---|
| Claude Code `Stop` hook | `catspec check --in-progress --format agent` | while a spec put in progress on this branch fails, the agent can't end its turn and gets the fix list (exit 2) |
| git pre-commit | `catspec check --staged` | no commit breaks a contract |

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

After 3 blocks in a row with the same failures (`--max-blocks`), the agent is let go and the user
is told that the item is stuck, so it can't loop forever.
