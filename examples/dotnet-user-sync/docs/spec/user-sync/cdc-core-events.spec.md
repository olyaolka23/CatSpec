---
catspec: 1
id: cdc-core-events
type: contract
status: implemented
bindings:
  - id: handler-interface
    symbol: Identity.Contracts.IMessageHandler
    kind: interface
    members:
      - { name: HandleAsync, params: ["*", CancellationToken], returns: Task }
  - id: event
    symbol: Identity.Contracts.UserUpdatedEvent
    kind: record
---

# CDC core events

## Contracts

- [binding:handler-interface] Every handler implements `IMessageHandler<T>`.
- [binding:event] `UserUpdatedEvent` carries the message id and the user id.

## Tasks

- [x] Define the message contracts.
