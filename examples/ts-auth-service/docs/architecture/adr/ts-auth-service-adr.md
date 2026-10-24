---
catspec: 1
id: architecture
title: Auth service architecture
type: architecture
status: implemented
rules:
  - id: storage-knows-no-services
    adr: ADR-001
    class: structural
    forbid_import:
      from: "src/storage/**"
      to: ["../services/*", "**/services/**"]
---

# Architecture Decision Records

## ADR-001: Storage doesn't depend on services

- **Status:** Accepted · **Date:** 2026-10-24
- **Context:** The token store is reused by other services.
- **Decision:** Code in `src/storage/` never imports from `src/services/`.
- **Consequences:** CatSpec reports such an import as CS0603.
