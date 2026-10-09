# F4 · `csharp-language-support`

> Feature of the epic **Reactive AST-Linked Spec Engine (CatSpec MVP v0.1)**.
> Estimate: 1.5 w · Depends on: F3 [`rule-engine-and-check`](./rule-engine-and-check.md) · Acceptance: `@AC-F4-1..3` (spec AC-1, AC-6 on C#).
> Order, progress and working rules: [`plan.md`](../plan.md) (Part I). Technical design `§Dn`: [`plan.md`](../plan.md) (Part II). Business spec `spec §n`: [`spec.md`](../spec.md).

## Description

The requirements' main target is .NET services. This feature gives C# the same
facts as TypeScript (namespaces, classes, records, interfaces, attributes like `[HttpGet]`,
constructors for dependency injection, partial classes), so all checks from F3 work on C# code
unchanged.

## Requirements covered

analysis C10; F-5 · plan §D5.3, §D11.2 · ADR-002, ADR-003

## Acceptance criteria

```gherkin
Feature: F4 csharp-language-support

  @AC-F4-1
  Scenario: The requirements' C# example passes (spec AC-1 on C#)
    Given the spec user-sync-handler binding Identity.Handlers.UserUpdatedHandler
    And it requires IMessageHandler<UserUpdatedEvent>, HandleAsync(UserUpdatedEvent, CancellationToken): Task
    And constructor dependencies ILogger and IEventStore
    When the C# code implements all of it and I run "catspec check"
    Then it exits 0
    But when HandleAsync is renamed, CS0203 is reported with did-you-mean

  @AC-F4-2
  Scenario: Architecture rule on C# (spec AC-6 on C#)
    Given a rule forbidding "using Infrastructure.*" in src/Domain/**
    When a Domain file has "using Infrastructure.Persistence;"
    Then CS0603 is reported

  @AC-F4-3
  Scenario: Partial classes count as one class
    Given partial class UserUpdatedHandler split over two files
    And HandleAsync is in the second file
    When the binding (file hint: both files via glob) is checked
    Then the member is found
```

## Definition of Done (feature)
- [ ] all PBIs meet the PBI checklist
- [ ] `@AC-F4-1..3` are automated and pass in CI on 3 OSes
- [ ] requirements review done; differences approved by the owner
- [ ] `catspec stage finish close csharp-language-support` passes
- [ ] owner approved closing the feature and ticking it in plan §1 Progress

## PBI `csharp-declarations`
Parses C# declarations: namespaces, types and their members, including newer C# syntax.
- depends on: `check-command`
- refs: §D11.2
- [ ] pinned `tree-sitter-c-sharp` → WASM
- [ ] namespaces (block + file-scoped), class / struct / record / interface / enum, nested types
- [ ] methods, properties, fields, events, constructors incl. primary constructors (C# 12)

```gherkin
  @AC-csharp-declarations-1
  Scenario: File-scoped namespaces give qualified names
    Given "namespace Identity.Handlers;" followed by class UserUpdatedHandler
    When facts are extracted
    Then the qualified name is Identity.Handlers.UserUpdatedHandler

  @AC-csharp-declarations-2
  Scenario: Primary constructors count as constructors
    Given "public class Handler(ILogger log, IEventStore store)"
    When facts are extracted
    Then the class has a constructor with parameters ILogger and IEventStore
```

## PBI `csharp-attributes-bases-imports`
Extracts attributes, base types, `using` directives and calls from C#.
- depends on: `csharp-declarations`
- refs: §D5.3, analysis F-5
- [ ] modifiers incl. `partial`, `async`, `override`; attributes with argument text
- [ ] base list → `bases`; documented `extends` heuristic
- [ ] `using` / `global using` as imports; alias map used to normalise base names in the same file
- [ ] calls: invocation and member-access text

```gherkin
  @AC-csharp-attributes-bases-imports-1
  Scenario: Attributes with arguments
    Given a method with [HttpGet("users")]
    When a binding requires attribute 'HttpGet("users")'
    Then the contract passes
    But with 'HttpGet("accounts")' it fails with CS0206

  @AC-csharp-attributes-bases-imports-2
  Scenario: using aliases are resolved in the same file
    Given "using Handler = Contracts.IMessageHandler<UserUpdatedEvent>;" and "class X : Handler"
    When the binding requires implements IMessageHandler<UserUpdatedEvent>
    Then the contract passes
```

## PBI `csharp-partials-and-types`
Merges partial classes and normalises C# type spellings.
- depends on: `csharp-attributes-bases-imports`
- refs: §D11.5
- [ ] merge `partial` declarations across the binding's file set
- [ ] type normalisation: `global::`, nullable `T?`, optional `System.` prefix, generic arity, tuples, arrays

```gherkin
  @AC-csharp-partials-and-types-1
  Scenario Outline: Equivalent C# type spellings match
    Given the expected type "<expected>"
    When it is matched against "<found>"
    Then they match
    Examples:
      | expected | found                      |
      | Task     | System.Threading.Tasks.Task |
      | string?  | global::System.String?     |
```

## PBI `csharp-acceptance`
Proves C# support end to end on a small "microservice" fixture built from the requirements' example.
- depends on: `csharp-partials-and-types`
- refs: spec §5 (AC-1, AC-6)
- [ ] fixture "microservice" with the requirements' `UserUpdatedHandler` example spec
- [ ] run `@AC-F4-1..3` against it

```gherkin
  @AC-csharp-acceptance-1
  Scenario: The microservice fixture behaves exactly as specified
    Given the "microservice" fixture
    When "catspec check" runs on the correct and on the broken variant
    Then the correct variant exits 0
    And the broken variant reports exactly the expected diagnostics in expected.json
```
