import { describe, expect, it } from "vitest";

import { readSpec, type Diagnostic } from "../src/index.js";

const FILE = "docs/spec/feature/login.spec.md";

/** A spec file whose frontmatter is the given lines after `catspec`, `id`, `type`, `status`. */
const spec = (lines: string[], body = "# Login\n"): string =>
  [
    "---",
    "catspec: 1",
    "id: login",
    "type: feature",
    "status: in-progress",
    ...lines,
    "---",
    "",
    body,
  ].join("\n");

const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => d.code);

describe("spec-schema", () => {
  it("[AC-spec-schema-1] expands shorthand members to full members", () => {
    const { spec: model, diagnostics } = readSpec(
      spec(["bindings:", "  - symbol: Auth.LoginService", "    members: [login, logout]"]),
      FILE,
    );
    expect(diagnostics).toEqual([]);
    expect(model!.bindings[0]!.members).toEqual([
      { name: "login", optional: false },
      { name: "logout", optional: false },
    ]);
    expect(model!.bindings[0]!.members.every((m) => m.kind === undefined)).toBe(true);
  });

  it("[AC-spec-schema-2] only warns about an unknown top-level key and still loads the spec", () => {
    const { spec: model, diagnostics } = readSpec(spec(["jira: ABC-1"]), FILE);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "CS0102",
      severity: "warning",
      spec: "login",
      specLocation: { file: FILE, line: 6, column: 1 },
    });
    expect(model).toBeDefined();
    expect(model!.valid).toBe(true);
    expect(model!.extra).toEqual({ jira: "ABC-1" });
  });

  it("[AC-spec-schema-3] marks a spec with depends_on but no bindings and no rules as aggregate", () => {
    const aggregate = readSpec(spec(["depends_on: [register-api, login-api]"]), FILE).spec!;
    expect(aggregate.aggregate).toBe(true);

    const withRules = readSpec(
      spec([
        "depends_on: [register-api]",
        "rules:",
        "  - { id: r, class: manual, text: Review it }",
      ]),
      FILE,
    ).spec!;
    expect(withRules.aggregate).toBe(false);
    expect(readSpec(spec([]), FILE).spec!.aggregate).toBe(false);
  });

  it("reads the full example spec of plan §D5.1 into the normalised model", () => {
    const text = spec([
      "title: User sync handler",
      "depends_on: [cdc-core-events]",
      'owners: ["@team-identity"]',
      "scope:",
      "  - src/Services/Identity/Handlers/**",
      "bindings:",
      "  - id: handler",
      "    symbol: Identity.Handlers.UserUpdatedHandler",
      "    kind: class",
      "    file: src/Services/Identity/Handlers/*.cs        # hint, optional",
      '    implements: ["IMessageHandler<UserUpdatedEvent>"]',
      "    constructor:",
      "      requires: [ILogger, IEventStore]",
      "    members:",
      "      - name: HandleAsync",
      "        kind: method",
      "        params: [UserUpdatedEvent, CancellationToken]",
      "        returns: Task",
      "        modifiers: [public]",
      "rules:",
      "  - id: no-console",
      "    class: structural",
      '    forbid_call: "Console.WriteLine"',
      "    within: handler",
      "  - id: idempotent",
      "    class: test",
      "    test: { symbol: UserUpdatedHandlerTests.HandleAsync_IsIdempotent, lang: csharp }",
      "  - id: dedup-review",
      "    class: manual",
      "    text: Deduplication must use the message id, not the payload hash.",
      "infrastructure:",
      "  - resource: AzureServiceBus",
      '    entity: "topic:user-events"',
      "waivers: []",
    ]);
    const { spec: model, diagnostics } = readSpec(text, FILE);
    expect(diagnostics).toEqual([]);
    expect(model).toMatchObject({
      id: "login",
      title: "User sync handler",
      status: "in-progress",
      dependsOn: ["cdc-core-events"],
      owners: ["@team-identity"],
      valid: true,
      aggregate: false,
    });
    expect(model!.bindings).toEqual([
      {
        id: "handler",
        symbol: "Identity.Handlers.UserUpdatedHandler",
        kind: "class",
        file: ["src/Services/Identity/Handlers/*.cs"],
        implements: ["IMessageHandler<UserUpdatedEvent>"],
        constructorRequires: ["ILogger", "IEventStore"],
        members: [
          {
            name: "HandleAsync",
            kind: "method",
            params: ["UserUpdatedEvent", "CancellationToken"],
            returns: "Task",
            modifiers: ["public"],
            optional: false,
          },
        ],
        index: 0,
      },
    ]);
    expect(model!.rules.map((r) => [r.id, r.class])).toEqual([
      ["no-console", "structural"],
      ["idempotent", "test"],
      ["dedup-review", "manual"],
    ]);
    expect(model!.infrastructure).toEqual([
      { resource: "AzureServiceBus", entity: "topic:user-events" },
    ]);
  });

  it("points an invalid binding kind at its line and lists the allowed kinds", () => {
    const { diagnostics } = readSpec(
      spec(["bindings:", "  - id: handler", "    symbol: A.B", "    kind: klass"]),
      FILE,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "CS0101",
      specLocation: { line: 9, column: 11 },
      actual: "klass",
      suggestions: [{ message: 'did you mean "class"?' }],
    });
    expect(diagnostics[0]!.message).toBe(
      'bindings[0].kind: invalid value "klass"; allowed: class, interface, struct, enum, record, function, method, type, module',
    );
  });

  it("reports every problem of a spec at once, each at its own line", () => {
    const { spec: model, diagnostics } = readSpec(
      [
        "---",
        "catspec: 2",
        "id: Bad_Id",
        "type: feature",
        "status: done",
        "bindings:",
        "  - symbol: A",
        "    implments: [B]",
        "  - kind: class",
        "rules:",
        "  - id: r1",
        "    class: strctural",
        "  - id: r2",
        "    class: structural",
        "  - id: r3",
        "    class: structural",
        "    forbid_call: x",
        "    require_call: y",
        "waivers:",
        "  - rule: r1",
        "    reason: later",
        "    until: 2026-13-45",
        "---",
        "",
      ].join("\n"),
      FILE,
    );
    expect(model).toBeUndefined();
    const lines = diagnostics.map((d) => [d.code, d.specLocation!.line, d.message]);
    expect(lines).toEqual([
      ["CS0101", 2, "catspec: invalid value 2; allowed: 1"],
      ["CS0101", 3, expect.stringContaining("id: must be 2–64 characters")],
      ["CS0101", 5, expect.stringContaining('status: invalid value "done"; allowed: draft, ready')],
      ["CS0101", 8, expect.stringContaining('unknown key "implments" in bindings[0]')],
      ["CS0101", 9, 'bindings[1]: missing required key "symbol"'],
      ["CS0101", 12, expect.stringContaining('rules[0].class: invalid value "strctural"')],
      ["CS0101", 13, expect.stringContaining("a structural rule needs one of forbid_call")],
      ["CS0101", 15, expect.stringContaining("found forbid_call, require_call")],
      ["CS0101", 22, "waivers[0].until: must be a valid date"],
    ]);
    expect(diagnostics[3]!.suggestions).toEqual([{ message: 'did you mean "implements"?' }]);
  });

  it("keeps the readable parts of an invalid spec, so its id still counts", () => {
    const { spec: model, diagnostics } = readSpec(spec(["depends_on: [a]", "owners: 7"]), FILE);
    expect(codes(diagnostics)).toEqual(["CS0101"]);
    expect(model).toMatchObject({ id: "login", valid: false, dependsOn: ["a"], aggregate: false });
  });

  it("reports duplicate binding and rule ids, and rules within an unknown binding", () => {
    const { diagnostics } = readSpec(
      spec([
        "bindings:",
        "  - symbol: Auth.Handler",
        "  - id: Handler",
        "    symbol: Other.Handler",
        "rules:",
        "  - { id: r, class: manual, text: a }",
        "  - { id: r, class: manual, text: b }",
        "  - { id: s, class: structural, forbid_call: x, within: handlr.run }",
      ]),
      FILE,
    );
    expect(diagnostics.map((d) => [d.code, d.specLocation!.line])).toEqual([
      ["CS0103", 8],
      ["CS0103", 12],
      ["CS0101", 13],
    ]);
    expect(diagnostics[0]!.message).toBe('duplicate binding id "Handler" (first used on line 7)');
    expect(diagnostics[2]!.suggestions).toEqual([{ message: 'did you mean "Handler"?' }]);
  });

  it("doesn't mistake JavaScript object keys for spec keys", () => {
    const { spec: model, diagnostics } = readSpec(spec(["bindings:", "  - symbol: A.B"]), FILE);
    expect(diagnostics).toEqual([]);
    expect(model!.bindings[0]!.constructorRequires).toBeUndefined();
    expect(model!.bindings[0]!.id).toBe("B");
  });

  it("validates query, test and manual rules, and ADR ids", () => {
    const { spec: model, diagnostics } = readSpec(
      spec([
        "rules:",
        "  - id: q",
        "    class: query",
        "    lang: csharp",
        "    query: (identifier) @x",
        "    adr: ADR-003",
        "  - id: t",
        "    class: test",
        "    test: { lang: csharp }",
        "  - id: m",
        "    class: manual",
        "    adr: adr-1",
        "    text: Review",
      ]),
      FILE,
    );
    expect(diagnostics.map((d) => [d.specLocation!.line, d.message])).toEqual([
      [14, 'rules[1].test: missing required key "symbol"'],
      [17, "rules[2].adr: must be an ADR id such as ADR-001"],
    ]);
    expect(model!.rules[0]).toMatchObject({
      id: "q",
      class: "query",
      expect: "absent",
      adr: "ADR-003",
    });
  });
});
