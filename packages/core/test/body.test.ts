import { describe, expect, it } from "vitest";

import { parseBody, readSpec } from "../src/index.js";

const FILE = "docs/spec/feature/logging.spec.md";
const FRONTMATTER = [
  "---",
  "catspec: 1",
  "id: logging",
  "type: feature",
  "status: draft",
  "bindings:",
  "  - id: handler",
  "    symbol: App.Handler",
  "rules:",
  "  - id: no-console",
  "    class: manual",
  "    text: No console logging.",
  "---",
];
const withBody = (body: string[]): string => [...FRONTMATTER, "", ...body, ""].join("\n");
const BODY_LINE = FRONTMATTER.length + 2;

describe("body-parser", () => {
  it("[AC-body-parser-1] reports CS0110 at the line of a reference to an unknown rule", () => {
    const { diagnostics } = readSpec(
      withBody(["# Logging", "", "## Contracts", "- [rule:no-consol] No console logging"]),
      FILE,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "CS0110",
      severity: "error",
      specLocation: { file: FILE, line: BODY_LINE + 3, column: 3 },
      actual: "no-consol",
      suggestions: [{ message: "did you mean [rule:no-console]?" }],
    });
  });

  it('[AC-body-parser-2] reports CS0111 "unenforced prose invariant" for a contract bullet without a reference', () => {
    const text = withBody([
      "## Contracts",
      "- [rule:no-console] No console logging.",
      "- [binding:handler] The handler exists.",
      "- Handlers are idempotent.",
    ]);
    const { diagnostics } = readSpec(text, FILE);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "CS0111",
      severity: "warning",
      specLocation: { line: BODY_LINE + 3, column: 1 },
    });
    expect(diagnostics[0]!.message).toContain("unenforced prose invariant");
    expect(diagnostics[0]!.message).toContain("Handlers are idempotent.");

    // `enforcement.unenforced_prose: off` turns it off; `Invariants` is checked like `Contracts`.
    expect(readSpec(text, FILE, { unenforcedProse: "off" }).diagnostics).toEqual([]);
    const invariants = readSpec(withBody(["### Invariants", "- Nothing checks this."]), FILE);
    expect(invariants.diagnostics.map((d) => d.code)).toEqual(["CS0111"]);
  });

  it("[AC-body-parser-3] counts task progress", () => {
    const { spec, diagnostics } = readSpec(
      withBody(["## Tasks", "- [x] Write the handler", "- [ ] Add retries", "- [X] Add tests"]),
      FILE,
    );
    expect(diagnostics).toEqual([]);
    const tasks = spec!.body.tasks;
    expect(tasks.filter((t) => t.done)).toHaveLength(2);
    expect(tasks).toHaveLength(3);
    expect(tasks[1]).toEqual({ text: "Add retries", done: false, line: BODY_LINE + 2 });
  });

  it("finds references anywhere except in code, and only counts checklists under Tasks", () => {
    const body = parseBody(
      [
        "# Title",
        "",
        "Prose with [binding:handler.HandleAsync] and `[rule:in-code]`.",
        "",
        "```",
        "[rule:in-a-code-block]",
        "```",
        "",
        "## Notes",
        "- [ ] not a task",
        "",
        "## Tasks",
        "- [ ] top",
        "  - [x] nested",
        "- plain bullet",
        "",
        "## ADR-007: A decision",
      ].join("\n"),
      1,
    );
    expect(body.title).toBe("Title");
    expect(body.references).toEqual([
      { kind: "binding", id: "handler.HandleAsync", line: 3, column: 12 },
    ]);
    expect(body.tasks.map((t) => [t.text, t.done])).toEqual([
      ["top", false],
      ["nested", true],
    ]);
    expect(body.adrIds).toEqual(["ADR-007"]);
  });

  it("accepts references to bindings by member and defaults the title to the first heading", () => {
    const { spec, diagnostics } = readSpec(
      withBody(["# Logging spec", "## Contracts", "- [binding:handler.Run] Runs."]),
      FILE,
    );
    expect(diagnostics).toEqual([]);
    expect(spec!.title).toBe("Logging spec");
  });
});
