# F2 · `typescript-language-support`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1.5 w · Depends on: F1 [`spec-model`](./spec-model.md) · Acceptance: `@AC-F2-1..3`.
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

To check code, CatSpec must "read" it. This feature parses TypeScript files with
Tree-sitter, without compiling anything, and turns them into a simple list of facts: which
classes, methods, interfaces, imports and calls exist and where. These facts are the same shape
for every language, so later checks work for C# too.

## Requirements covered

analysis C10; F-5, F-16 · plan §D11.2, §D11.7 · ADR-002, ADR-003.

## Acceptance criteria

```gherkin
Feature: F2 typescript-language-support

  @AC-F2-1
  Scenario: Facts for a TypeScript class
    Given "src/services/AuthService.ts" exporting class AuthService implements IAuthService
    And it has methods login(user: string) and validateToken(t: string): Promise<boolean>
    When I run "catspec show-facts src/services/AuthService.ts"
    Then the facts list class AuthService, exported, with base IAuthService
    And method validateToken with params [string] and return type Promise<boolean>

  @AC-F2-2
  Scenario: Broken files don't crash CatSpec
    Given a TypeScript file with a syntax error in the middle
    When its facts are extracted
    Then the declarations before and after the error are still listed
    And CS0901 reports the error location

  @AC-F2-3
  Scenario: Unchanged files are not parsed again
    Given facts were extracted for a file
    When they are requested again and the file content hasn't changed
    Then they come from the cache without parsing
```

## Definition of Done (feature)
- [x] all PBIs meet the PBI checklist
- [x] `@AC-F2-1..3` are automated and pass in CI on 3 OSes
- [x] requirements review done; differences approved by the owner
- [x] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `adapter-interface`
Defines the language-independent "facts" model and the plug-in interface every language adapter implements.
- depends on: `cli-skeleton`
- refs: §D11.2, ADR-003
- [x] `LanguageAdapter`, `FileFacts`, `SymbolFact`, `ImportFact`, `CallFact` types **in `core`**
- [x] adapter registry in `lang`; language chosen by extension + `languages.*.include/exclude`

```gherkin
  @AC-adapter-interface-1
  Scenario: core stays parser-free
    Given the core package
    When its dependencies and imports are inspected
    Then it doesn't depend on web-tree-sitter or any adapter package

  @AC-adapter-interface-2
  Scenario: Files are routed to the right adapter
    Given config including "src/**/*.ts" for typescript
    When "src/a.ts" and "docs/b.ts" are resolved
    Then "src/a.ts" goes to the TypeScript adapter and "docs/b.ts" is ignored
```

## PBI `tree-sitter-runtime`
Loads Tree-sitter and the language grammars as WASM files, so CatSpec runs everywhere without native builds.
- depends on: `adapter-interface`
- refs: §D11.1, ADR-002
- [x] `web-tree-sitter` initialised once; grammar `.wasm` loaded from the adapter package
- [x] `scripts/build-grammars`: build pinned grammar releases to WASM (interim: prebuilt `tree-sitter-wasms`, pinned)
- [x] query runner: compile `.scm` once per language; typed capture iteration

```gherkin
  @AC-tree-sitter-runtime-1
  Scenario: Parsing works without a compiler
    Given a machine with Node only (no C toolchain) on Linux, macOS or Windows
    When a TypeScript file is parsed
    Then parsing succeeds

  @AC-tree-sitter-runtime-2
  Scenario: Queries are compiled once
    Given 100 files of the same language
    When they are parsed
    Then each query is compiled exactly once
```

## PBI `type-normaliser`
Compares type names the way people write them, e.g. `IMessageHandler<UserUpdatedEvent>` matches `Contracts.IMessageHandler<Events.UserUpdatedEvent>`.
- depends on: `adapter-interface`
- refs: §D11.5, analysis F-5
- [x] parse type text like `A.B<C.D, E>` into a tree; segment-wise suffix matching
- [x] qualified-name suffix matching for symbols

```gherkin
  @AC-type-normaliser-1
  Scenario Outline: Suffix matching of types
    Given the expected type "<expected>"
    When it is matched against the found type "<found>"
    Then the result is <match>
    Examples:
      | expected                          | found                                              | match |
      | IMessageHandler<UserUpdatedEvent> | Contracts.IMessageHandler<Events.UserUpdatedEvent> | true  |
      | IMessageHandler<UserUpdatedEvent> | IMessageHandler<UserDeletedEvent>                  | false |
      | Handler                           | MyHandler                                          | false |
```

## PBI `typescript-adapter`
Extracts the facts from TypeScript and TSX files: declarations, members, decorators, imports and calls.
- depends on: `tree-sitter-runtime`, `type-normaliser`
- refs: §D11.2
- [x] declarations: class, interface, type alias, enum, function, exported const arrow functions, methods, properties, constructor params (incl. parameter properties), getters / setters, overloads
- [x] modifiers, decorators (name + args), `export` / `export default`, `implements` / `extends`, generics
- [x] imports (static, `import type`, literal `import()`, literal `require`); re-exports recorded, not resolved
- [x] calls (callee text + enclosing symbol); qualified names `path#Outer.Inner`
- [x] type normalisation (`Array<T>` ≡ `T[]`, whitespace, `readonly` params); partial facts + CS0901 on parse errors
- [x] hidden debug command `catspec show-facts <file>`

```gherkin
  @AC-typescript-adapter-1
  Scenario: Golden facts
    Given the ~25 TypeScript fixtures, one per language feature
    When facts are extracted
    Then they equal the reviewed golden JSON files

  @AC-typescript-adapter-2
  Scenario: Constructor parameter properties count as DI parameters
    Given "constructor(private log: ILogger) {}"
    When facts are extracted
    Then the constructor has a parameter of type ILogger and the class has a property "log"

  @AC-typescript-adapter-3
  Scenario: Calls know their enclosing symbol
    Given console.log(...) inside method AuthService.login
    When facts are extracted
    Then there is a call "console.log" enclosed by "AuthService.login"
```

## PBI `parse-cache-and-index`
Makes repeated checks fast by caching facts by file content, and finds symbols anywhere in the repo.
- depends on: `typescript-adapter`
- refs: §D11.7, analysis F-16
- [x] cache `FileFacts` by git blob SHA in `<git-common-dir>/catspec/cache/<lang>/`, keyed by adapter + grammar version; in-memory fallback outside git
- [x] lazy repo-wide symbol index (name → symbol ids)

```gherkin
  @AC-parse-cache-and-index-1
  Scenario: Cache invalidates on a grammar upgrade
    Given cached facts produced with grammar version 1
    When CatSpec runs with grammar version 2
    Then the file is parsed again

  @AC-parse-cache-and-index-2
  Scenario: Find a symbol anywhere
    Given class AuthService in "src/a/AuthService.ts"
    When the index is asked for "AuthService"
    Then it returns that file and symbol id
```
