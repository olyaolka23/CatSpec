---
catspec: 1
id: user-sync-handler
type: feature
status: ready
depends_on: [cdc-core-events]
bindings:
  - id: handler
    symbol: Identity.Handlers.UserHandler
    kind: class
    file: src/Services/Identity/Handlers/*.cs
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

- [binding:handler] The handler gets `ILogger` and `IEventStore` injected and handles `UserUpdatedEvent`.
- [rule:no-console] No direct console logging; use `ILogger`.

## Tasks

- [x] Handle `UserUpdatedEvent` once per message id.
