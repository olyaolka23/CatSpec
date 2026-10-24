# Workflow presets

CatSpec doesn't replace your spec-driven workflow; it gates its steps. A workflow is a list of
stages. Each stage has a driver (a skill, a slash command or a command), the files it produces, and
gates checked when it starts and finishes, which can also change spec statuses. The full design is
in [plan §D17](../reactive-ast-linked-spec-engine/plan.md#d17-workflow-profiles-plugging-catspec-into-any-sdd-workflow-f-20-adr-015).

```yaml
# catspec.yaml
workflow:
  preset: catspec          # catspec | openspec | spec-kit | custom
```

`catspec init` detects `openspec/`, `.specify/` or `sdd-*` skills and picks the matching preset;
`--preset` overrides it.

## Presets

| Preset | Feature folder | Stages (driver) | Gates CatSpec adds |
|---|---|---|---|
| `catspec` (default) | `docs/spec/{feature}` | spec → plan → task → close (CatSpec's MCP prompts) | spec: specs valid, files exist; plan: dependencies known → `ready`; task: dependencies ready → `in-progress`, then contracts pass; close: contracts pass, tasks ticked, no drift → `implemented` |
| `openspec` | `openspec/changes/{feature}` | proposal (`/opsx:propose`) → apply (`/opsx:apply`) → archive (`/opsx:archive`) | archive can't start while contracts fail or tasks are unticked; archived `*.spec.md` stay enforced |
| `spec-kit` | `specs/{feature}` | specify → plan → tasks → implement (`/speckit.*`) | implement can't finish while contracts fail or tasks are unticked |
| `custom` | your `feature_dir` | your stages | your gates |

## Custom stages

```yaml
workflow:
  preset: custom
  feature_dir: "docs/spec/{feature}"
  skills_dir: ".claude/skills"
  stages:
    - id: spec
      per: feature                     # once per feature (epic)
      driver: { skill: sdd-spec }
      produces: ["{feature_dir}/spec.md", "{feature_dir}/*.spec.md"]
      finish: { gates: [specs_valid, artifacts, contracts_declared] }
    - id: task
      per: spec                        # once per work item (PBI)
      driver: { skill: sdd-task }
      start:  { gates: [deps_ready], status: in-progress }
      finish: { gates: [contracts_pass] }
    - id: close
      per: spec
      driver: { skill: sdd-close }
      finish: { gates: [contracts_pass, tasks_done, no_drift], status: implemented }
```

## Gates

| Gate | Passes when |
|---|---|
| `specs_valid` | the feature's specs pass `catspec check --specs-only` |
| `artifacts` | every `produces` path exists and isn't empty |
| `contracts_declared` | every spec has a binding or an enforceable rule |
| `deps_known` | every `depends_on` id exists |
| `deps_ready` | every dependency is implemented and passes |
| `contracts_pass` | `catspec check --spec <id>` is DONE for every spec |
| `tasks_done` | every `- [ ]` under the spec's `Tasks` is ticked (`tasks.md` for per-feature stages) |
| `no_drift` | no CS0300 |
| `adr_valid` | the ADR log is valid and its rules name existing ADRs |
| `command: "<cmd>"` | the command exits 0; runs only with `workflow.allow_commands: true`, never through a shell |

A failing gate is CS0701 (start) or CS0702 (finish), with the diagnostics behind it.

## Commands

```bash
catspec next <feature>                       # the current stage, its driver, what's ready or waiting
catspec stage start  <stage> <feature|spec>
catspec stage finish <stage> <feature|spec>  # --force goes ahead with a warning and logs it
catspec workflow show [feature]              # where each feature and work item is
catspec workflow doctor                      # do the skills and commands exist? (CS0704)
catspec workflow snippet <stage|agents>      # lines to paste into a skill, or the AGENTS.md block
```

`--force` writes to `<git-common-dir>/catspec/workflow-overrides.log`. It never sets
`implemented` while contracts fail, and agents can't force a stage over MCP. With
`workflow.enforce_in_hook`, the pre-commit hook re-checks the final gates of implemented specs
(CS0703).
