---
catspec: 1
id: token-store
type: component
status: implemented
bindings:
  - id: store
    symbol: TokenStore
    kind: class
    file: src/storage/TokenStore.ts
    members:
      - { name: save, params: [string, string], returns: void }
      - { name: find, params: [string] }
      - remove
---

# Token store

## Contracts

- [binding:store] Tokens can be saved, found and removed.

## Tasks

- [x] Keep tokens in memory.
