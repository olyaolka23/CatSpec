---
catspec: 1
id: core-public-api
title: Core public API (language adapter contract)
type: contract
status: implemented
owners: ["@olyaolka23"]
scope:
  - packages/core/src/**
bindings:
  - id: adapter
    symbol: packages/core/src/facts#LanguageAdapter
    kind: interface
    exported: true
    members:
      - { name: id, kind: property, returns: string }
      - { name: extensions, kind: property }
      - { name: version, kind: property, returns: string }
      - { name: load, kind: method, params: [], returns: Promise<void> }
      - { name: extract, kind: method, params: [SourceFile], returns: FileFacts }
      - { name: normalizeType, kind: method, params: [string], returns: TypeRef }
      - { name: qualify, kind: method, params: [SymbolFact, SourceFile], returns: string }
      - { name: checkQuery, kind: method, params: [string], optional: true }
      - { name: runQuery, kind: method, params: [SourceFile, string], optional: true }
  - id: facts
    symbol: packages/core/src/facts#FileFacts
    kind: interface
    exported: true
    members:
      - { name: path, returns: string }
      - { name: blobSha, returns: string }
      - { name: lang, returns: string }
      - { name: symbols, returns: "SymbolFact[]" }
      - { name: imports, returns: "ImportFact[]" }
      - { name: calls, returns: "CallFact[]" }
      - { name: parseErrors, returns: "Range[]" }
rules:
  - id: core-does-not-print
    class: structural
    forbid_call: "console.*"
  - id: no-shell
    adr: ADR-009
    class: structural
    forbid_call: "child_process.exec"
---

# Core public API

The contract between `@catspec/core` and the language adapters (ADR-003, plan §D11.2).
Adapters depend on these shapes; changing them is a breaking change.

## Contracts

- [binding:adapter] Every language plugs in through `LanguageAdapter`; `query` rules reach syntax only through its optional `checkQuery` / `runQuery`.
- [binding:facts] Rules read only `FileFacts`, never syntax trees.
- [rule:core-does-not-print] Core returns diagnostics; only the CLI and MCP print.
- [rule:no-shell] Processes (git, test commands) run with `execFile`, never through a shell (ADR-009).
