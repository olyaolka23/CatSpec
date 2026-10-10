import { createDiagnostic, type Diagnostic } from "@catspec/core";
import { describe, expect, it } from "vitest";

import { EXIT, exitCodeFor, formatJson, formatText } from "../src/index.js";

const at = (line: number, column = 1) => ({ file: "docs/spec/auth/login.spec.md", line, column });

const warning = createDiagnostic("CS0102", {
  spec: "login",
  specLocation: at(6),
  message: 'unknown key "jira" is ignored',
});
const error = createDiagnostic("CS0101", {
  spec: "login",
  specLocation: at(9, 11),
  message: 'bindings[0].kind: invalid value "klass"; allowed: class, interface',
  expected: ["class", "interface"],
  actual: "klass",
  suggestions: [{ message: 'did you mean "class"?' }],
});

describe("reporters", () => {
  it("[AC-diagnostics-core-1] exits 0 with only warnings and 1 with at least one error", () => {
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor([warning])).toBe(EXIT.ok);
    expect(exitCodeFor([warning, { ...warning, severity: "info" }])).toBe(0);
    expect(exitCodeFor([warning, error])).toBe(EXIT.errors);
    expect(EXIT).toEqual({ ok: 0, errors: 1, usage: 2, internal: 3 });
  });

  it("[AC-diagnostics-core-3] writes valid JSON with code, severity, locations and message for each diagnostic", () => {
    const report = JSON.parse(formatJson([warning, error], 1)) as {
      diagnostics: Diagnostic[];
      summary: Record<string, number>;
    };
    expect(report.diagnostics).toHaveLength(2);
    for (const d of report.diagnostics) {
      expect(Object.keys(d)).toEqual(
        expect.arrayContaining(["code", "severity", "specLocation", "message"]),
      );
    }
    expect(report.diagnostics[0]).toEqual({ ...warning });
    expect(report.diagnostics[1]).toMatchObject({
      code: "CS0101",
      severity: "error",
      specLocation: { file: "docs/spec/auth/login.spec.md", line: 9, column: 11 },
      expected: ["class", "interface"],
      actual: "klass",
    });
    expect(report.summary).toEqual({ errors: 1, warnings: 1, infos: 0, specs: 1 });
  });

  it("groups text output by spec, with ✔ for clean specs and a summary", () => {
    const text = formatText([error, warning], {
      specs: [
        { id: "login", file: "docs/spec/auth/login.spec.md" },
        { id: "logout", file: "docs/spec/auth/logout.spec.md" },
      ],
    });
    expect(text).toBe(
      [
        "✖ login  docs/spec/auth/login.spec.md",
        '  6:1  CS0102 unknown key "jira" is ignored',
        '  9:11  CS0101 bindings[0].kind: invalid value "klass"; allowed: class, interface',
        '               ↳ did you mean "class"?',
        "✔ logout  docs/spec/auth/logout.spec.md",
        "1 error, 1 warning in 2 specs",
        "",
      ].join("\n"),
    );
    expect(formatText([error, warning], { quiet: true })).not.toContain("CS0102");
    expect(formatText([], { specs: [] })).toBe("0 errors, 0 warnings in 0 specs\n");
  });
});
