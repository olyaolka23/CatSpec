---
catspec: 1
id: architecture
title: User sync architecture
type: architecture
status: implemented
rules:
  - id: domain-is-pure
    adr: ADR-001
    class: structural
    forbid_import:
      from: "src/Domain/**"
      to: ["Infrastructure.*"]
---

# Architecture Decision Records

## ADR-001: The domain doesn't know the infrastructure

- **Status:** Accepted · **Date:** 2026-10-24
- **Context:** Domain types are shared by every service and tested without a database.
- **Decision:** Code in `src/Domain/` never uses a namespace under `Infrastructure`.
- **Consequences:** CatSpec reports such a `using` as CS0603.
