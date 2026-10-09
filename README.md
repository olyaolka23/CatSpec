# CatSpec

Reactive, AST-linked specifications for spec-driven development with AI agents.

CatSpec binds Markdown specs (`*.spec.md`) to real code symbols, checks their
invariants with Tree-sitter, blocks commits that break satisfied contracts, and
gives AI agents spec context and self-verification through an MCP server.

## Design documents

Feature: Reactive AST-Linked Spec Engine (`docs/spec/reactive-ast-linked-spec-engine/`)

1. [Requirements analysis](docs/spec/reactive-ast-linked-spec-engine/analysis.md): gaps in the original idea and the decisions taken
2. [Product & technical specification (MVP)](docs/spec/reactive-ast-linked-spec-engine/spec.md)
3. [Implementation plan](docs/spec/reactive-ast-linked-spec-engine/plan.md)

Architecture decisions: [`guidelines/architecture/ADR.md`](guidelines/architecture/ADR.md).
Repository conventions for agents and contributors: [`AGENTS.md`](AGENTS.md).
