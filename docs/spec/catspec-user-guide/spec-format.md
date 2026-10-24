# Spec format

A machine spec is a Markdown file named `<spec-id>.spec.md` in a feature folder
(`docs/spec/<feature>/`, set by `specs.include`). Its YAML frontmatter is what CatSpec checks; its
body is for people and agents. The full design is in [plan §D5](../reactive-ast-linked-spec-engine/plan.md#d5-spec-file-format--specmd);
editors get autocompletion from the JSON Schema `node_modules/@catspec/core/schemas/spec.schema.json`.

## Example

```markdown
---
catspec: 1
id: user-sync-handler
type: feature
status: in-progress
depends_on: [cdc-core-events]
bindings:
  - id: handler
    symbol: Identity.Handlers.UserUpdatedHandler
    kind: class
    file: src/Services/Identity/Handlers/*.cs        # a hint only
    implements: ["IMessageHandler<UserUpdatedEvent>"]
    constructor:
      requires: [ILogger, IEventStore]
    members:
      - name: HandleAsync
        params: [UserUpdatedEvent, CancellationToken]
        returns: Task
rules:
  - id: no-console
    class: structural
    forbid_call: "Console.WriteLine"
    within: handler
---

# User sync handler

## Contracts
- [binding:handler] Dependencies `ILogger` and `IEventStore` are injected.
- [rule:no-console] No direct console logging.

## Tasks
- [ ] Create the handler.
```

## Frontmatter

| Field | Required | Meaning |
|---|---|---|
| `catspec` | yes | format version, `1` |
| `id` | yes | `^[a-z0-9][a-z0-9-]{1,63}$`, unique in the repository |
| `type` | yes | `feature`, `component`, `contract`, `architecture` or `adr` |
| `status` | yes | `draft`, `ready`, `in-progress`, `implemented` or `deprecated` |
| `title` | no | defaults to the first `#` heading |
| `depends_on` | no | ids of specs that must exist; no cycles |
| `owners`, `infrastructure`, `links` | no | information for people and agents, not checked |
| `scope` | no | extra paths that belong to the spec |
| `bindings` | no | the code the spec is about (below) |
| `rules` | no | invariants: see the [rule catalogue](./rules.md) |
| `waivers` | no | temporary exceptions to rules: see [waivers](./rules.md#waivers) |

An unknown top-level key is a warning (CS0102), so teams can add their own metadata.

## Bindings

A binding names a declaration and its contract:

| Field | Meaning |
|---|---|
| `id` | local id, used by `within` and by `[binding:id]` in the body; defaults to the symbol's last segment |
| `symbol` | qualified name, matched by suffix: C# `Namespace.Type`, TypeScript `Name` (or `path/module#Name`) |
| `kind` | `class`, `interface`, `struct`, `enum`, `record`, `function`, `method`, `type` or `module` |
| `file` | path, glob or list: a **hint**. Moving the file doesn't break the spec. C# `partial` parts are merged |
| `implements` / `extends` | direct interfaces and base class |
| `attributes` | C# attributes or TypeScript decorators, e.g. `HttpGet("users")` |
| `constructor.requires` | types that must be parameters of a constructor (dependency injection) |
| `members` | a name, or `{ name, kind, params, returns, modifiers, attributes, optional }` |
| `exported` | TypeScript: exported; C#: `public` |

`params` are type strings in order (`"*"` matches any type). A member written as a bare name is
checked by name only; its signature is then covered only by drift detection.

`catspec bind <symbol> --spec <id>` writes a binding for existing code, with its current shape.

## Body

- `[rule:<id>]` and `[binding:<id>]` link prose to the contract; an unknown id is CS0110.
- A bullet under a `Contracts` or `Invariants` heading without such a link is CS0111 (prose
  nothing enforces).
- The `- [ ]` checklist under `Tasks` is the spec's progress (the `tasks_done` gate).

## Statuses and enforcement

```
draft ──► ready ──► in-progress ──► implemented ──► deprecated
```

| | draft / ready | in-progress | implemented |
|---|---|---|---|
| contract fails, never passed | not checked | warning | **error** |
| contract fails after it passed once | not checked | **error** (ratchet) | **error** |
| signature changed (drift, CS0300) | not checked | info | `enforcement.drift` |

- `catspec status <id> in-progress` needs every dependency implemented and passing (CS0502);
  `implemented` also needs the spec's own contracts to pass. `--force` skips only the dependency
  check.
- The ratchet lives in the lock file next to the spec (`<spec-id>.lock.json`): what passed, where
  each binding resolved and its shape. The hook writes it; commit it; never edit it by hand.
- An intended signature change: `catspec accept <id>`. Rebuild every lock file:
  `catspec baseline --rebuild`.
- Renames and moves: `catspec sync` shows the spec edits, `catspec sync --apply` makes them. For a
  large refactor, run `catspec refactor --scope "<glob>"` first (plan §D11.8).
