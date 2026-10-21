# F7 · `mcp-server-and-agent-layer`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1 w · Depends on: F6 [`rename-and-refactor`](./rename-and-refactor.md) · Acceptance: `@AC-F7-1..4` (spec AC-9, AC-10, AC-17).
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

AI agents use CatSpec by themselves. Through the MCP server an agent reads the
spec, checks its own code and fixes it before it ever says "done". A Claude Code hook stops the
agent from ending its turn while the work it's doing still fails its checks, and the agent can't
"pass" by weakening the spec. The developer only reviews.

## Requirements covered

analysis C8; F-13, F-18 · plan §D14 · ADR-008, ADR-016, ADR-024.

## Acceptance criteria

```gherkin
Feature: F7 mcp-server-and-agent-layer

  @AC-F7-1
  Scenario: The agent fixes its own mistake (spec AC-9)
    Given an agent connected to "catspec mcp" and the spec login requiring method login
    When the agent writes signIn and calls check_compliance
    Then it receives CS0203 "expected login, found signIn"
    When the agent renames the method and calls check_compliance again
    Then it receives done: true and set_spec_status implemented succeeds

  @AC-F7-2
  Scenario: The agent can't weaken a contract (spec AC-10)
    Given mcp.allow_contract_edits is false
    When the agent calls update_spec_bindings to remove a member
    Then the tool returns a proposal and the spec file is unchanged

  @AC-F7-3
  Scenario: The agent can't stop early (spec AC-17)
    Given the Claude Code Stop hook is installed and register-api is in-progress with login missing
    When the agent tries to end its turn
    Then the hook exits 2 and the agent receives the fix list
    And after 3 identical failures in a row the agent is let go and the user is told the item is stuck

  @AC-F7-4
  Scenario: A real Claude Code session
    Given the TypeScript AuthService fixture with "catspec init --agents" applied
    When Claude Code implements the spec
    Then the work reaches implemented without a human typing any catspec command
```

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F7-1..3` are automated and pass in CI on 3 OSes; `@AC-F7-4` is a recorded manual run (transcript in `examples/`)
- [ ] requirements review done; differences approved by the owner
- [ ] `catspec stage finish close mcp-server-and-agent-layer` passes
- [ ] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `mcp-server-core`
The MCP server process: stdio transport, a warm engine between calls, and a strict repository boundary.
- depends on: `refactor-mode`
- refs: §D14
- [ ] `@catspec/mcp` on `@modelcontextprotocol/server`, v2 of the MCP SDK (stdio, ADR-024); `catspec mcp`
- [ ] warm engine between calls; config / spec reload on change; repo-root path guard

```gherkin
  @AC-mcp-server-core-1
  Scenario: Paths outside the repository are refused
    Given the MCP server running in /repo
    When a tool is called with file_path "../../etc/passwd"
    Then an error result is returned and nothing is read

  @AC-mcp-server-core-2
  Scenario: Edited specs are picked up
    Given the server has answered get_spec_context for login
    When login.spec.md changes on disk
    Then the next call returns the new content
```

## PBI `mcp-tools`
The tools agents call: context, compliance checks, dependencies, safe spec edits, status and refactor.
- depends on: `mcp-server-core`
- refs: §D14.1, ADR-008
- [ ] `list_specs`, `get_spec_context`, `check_compliance`, `find_specs_for_file`, `check_dependencies`
- [ ] `update_spec_bindings` (`dry_run` default; contract edits only proposed unless `mcp.allow_contract_edits`)
- [ ] `set_spec_status` (refuses `implemented` while contracts fail, and lowering a status, `deprecated` or the architecture spec); `start_refactor`, `sync_specs`
- [ ] text + `structuredContent` outputs; diagnostics are results, not protocol errors

```gherkin
  @AC-mcp-tools-1
  Scenario: Agent loop (spec AC-9)
    Given a scripted agent using the in-process MCP client
    When it runs get_spec_context, check_compliance, fixes the code, and calls check_compliance again
    Then the second result has done: true

  @AC-mcp-tools-2
  Scenario: Contract edits are only proposed (spec AC-10)
    Given mcp.allow_contract_edits is false
    When update_spec_bindings removes a member with dry_run false
    Then the result is a proposal with a diff and the file is unchanged

  @AC-mcp-tools-3
  Scenario: Status can't be faked
    Given a spec with a failing contract
    When set_spec_status implemented is called
    Then it is refused and the failing contract is listed
```

## PBI `mcp-resources-and-prompts`
Read-only resources (spec, architecture, graph, last diagnostics) and ready-made prompts for agents.
- depends on: `mcp-tools`
- refs: §D14.2
- [ ] resources `catspec://spec/{id}`, `catspec://architecture`, `catspec://graph`, `catspec://diagnostics`
- [ ] prompts `implement-spec`, `fix-drift`

```gherkin
  @AC-mcp-resources-and-prompts-1
  Scenario: Resources are listed and readable
    Given a repository with spec login
    When the client lists and reads resources
    Then "catspec://spec/login" returns the raw spec file and "catspec://graph" a mermaid graph
```

## PBI `agent-check-mode`
`check --in-progress --format agent`: the check made for agent hooks, with loop protection.
- depends on: `check-command`
- refs: §D10, §D14.3
- [ ] `check --in-progress` (specs `in-progress` on the current branch; exit 0 when none)
- [ ] `--format agent`: short fix list; exit 0 done / 2 not done / 1 error
- [ ] loop protection: read the hook input from stdin, `--max-blocks` (default 3) with the same diagnostics, counter in the runtime store

```gherkin
  @AC-agent-check-mode-1
  Scenario Outline: Exit codes in agent format
    Given <situation>
    When "catspec check --in-progress --format agent" runs
    Then the exit code is <code>
    Examples:
      | situation                              | code |
      | no spec in progress                    | 0    |
      | an in-progress spec with all checks OK | 0    |
      | an in-progress spec with a failure     | 2    |
      | an invalid catspec.yaml                | 1    |

  @AC-agent-check-mode-2
  Scenario: Loop protection
    Given the same failure blocked the agent 3 times in a row
    When the hook runs a 4th time with the same diagnostics
    Then it exits 0 and tells the user the item is stuck
```

## PBI `agent-setup`
`catspec init --agents`: writes the agent instructions and the Claude Code hook, without touching anything else.
- depends on: `agent-check-mode`, `mcp-tools`
- refs: §D14.3, §D17.5
- [ ] `AGENTS.md` block between `catspec:begin/end` markers (created or updated, rest untouched)
- [ ] merge the Claude Code `Stop` hook into `.claude/settings.json` without losing existing hooks
- [ ] docs: MCP setup for Claude Code (`claude mcp add catspec -- npx catspec mcp`), Claude Desktop, Cursor, Windsurf

```gherkin
  @AC-agent-setup-1
  Scenario: Existing AGENTS.md content is preserved
    Given an AGENTS.md with the team's own rules
    When I run "catspec init --agents" twice
    Then the CatSpec block appears exactly once between its markers
    And the team's rules are byte-for-byte unchanged

  @AC-agent-setup-2
  Scenario: Existing Claude Code hooks are preserved
    Given .claude/settings.json with a PostToolUse hook
    When I run "catspec init --agents"
    Then the Stop hook is added and the PostToolUse hook is unchanged

  @AC-agent-setup-3
  Scenario: The agent can't stop early (spec AC-17)
    Given the installed Stop hook and an in-progress spec with a missing member
    When the agent ends its turn
    Then the stop is blocked with the fix list
```

## PBI `claude-code-validation`
A real end-to-end run with Claude Code, recorded as evidence that the agent workflow works.
Runs after F8, which adds the stage commands the scenario uses.
- depends on: `agent-setup`, `mcp-resources-and-prompts`
- refs: §D14.3
- [ ] run the `AuthService` user journey with Claude Code on the TS fixture
- [ ] save the transcript in `examples/` of the epic folder (propose it to the owner first; Rule 3)

```gherkin
  @AC-claude-code-validation-1
  Scenario: Hands-off implementation
    Given the AuthService fixture with "catspec init --agents"
    When the developer asks Claude Code to implement the spec and only reviews
    Then the transcript shows the agent running stage start, check and stage finish by itself
    And the spec ends as implemented
```
