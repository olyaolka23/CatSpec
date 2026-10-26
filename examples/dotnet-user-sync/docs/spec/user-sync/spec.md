# User sync: spec

The identity service publishes `UserUpdatedEvent`; a handler keeps the user read model in sync,
once per message.

- [`cdc-core-events.spec.md`](./cdc-core-events.spec.md): the message contracts.
- [`user-sync-handler.spec.md`](./user-sync-handler.spec.md): the handler.
