import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gitBlobSha, parseErrorDiagnostics, type FileFacts, type SourceFile } from "@catspec/core";
import { beforeAll, describe, expect, it } from "vitest";

import { fixturesDir } from "../../../test/fixtures.js";
import { TypeScriptAdapter } from "../src/index.js";

/** Golden facts: `fixtures/typescript-facts/<case>/src/<file>` and its reviewed `expected.json`. */
const goldenDir = join(fixturesDir, "typescript-facts");

const adapter = new TypeScriptAdapter();
beforeAll(() => adapter.load());

const source = (path: string, text: string): SourceFile => ({
  path,
  text,
  blobSha: gitBlobSha(text),
});

const facts = (text: string, path = "src/file.ts"): FileFacts =>
  adapter.extract(source(path, text));

describe("TypeScript adapter", () => {
  it("[AC-typescript-adapter-1] extracts facts equal to the reviewed golden JSON of each fixture", () => {
    const cases = readdirSync(goldenDir).sort();
    expect(cases.length).toBeGreaterThanOrEqual(25);
    for (const name of cases) {
      const [file] = readdirSync(join(goldenDir, name, "src"));
      const path = `src/${file}`;
      const actual = adapter.extract(
        source(path, readFileSync(join(goldenDir, name, path), "utf8")),
      );
      const expectedFile = join(goldenDir, name, "expected.json");
      // UPDATE_GOLDEN=1 rewrites the golden files; review the diff before committing it.
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(expectedFile, `${JSON.stringify(actual, null, 2)}\n`);
      }
      expect(existsSync(expectedFile), `${name} has no expected.json`).toBe(true);
      const expected = JSON.parse(readFileSync(expectedFile, "utf8")) as FileFacts;
      expect(actual, name).toEqual(expected);
    }
  });

  it('[AC-typescript-adapter-2] turns "constructor(private log: ILogger) {}" into a constructor parameter and a property', () => {
    const [service] = facts("class Service {\n  constructor(private log: ILogger) {}\n}\n").symbols;
    const constructor = service!.members.find((m) => m.kind === "constructor");
    expect(constructor?.params).toEqual([
      {
        name: "log",
        type: { text: "ILogger", name: ["ILogger"], args: [] },
        modifiers: ["private"],
        attributes: [],
      },
    ]);
    const property = service!.members.find((m) => m.kind === "property");
    expect(property).toMatchObject({
      name: "log",
      qualifiedName: "Service.log",
      modifiers: ["private"],
      returns: { text: "ILogger" },
    });
  });

  it('[AC-typescript-adapter-3] records console.log(...) in AuthService.login as a call "console.log" enclosed by "AuthService.login"', () => {
    const { calls, symbols } = facts(
      "export class AuthService {\n  login(user: string) {\n    console.log(user);\n  }\n}\n",
    );
    const login = symbols[0]!.members[0]!;
    expect(login.qualifiedName).toBe("AuthService.login");
    expect(calls).toEqual([
      {
        callee: "console.log",
        enclosing: "src/file.ts#AuthService.login",
        range: { start: { line: 3, column: 5 }, end: { line: 3, column: 22 } },
      },
    ]);
  });

  it("[AC-F2-2] keeps the declarations before and after a syntax error and reports CS0901 at the error", () => {
    const broken = [
      "export class Before {", // 1
      "  run(): void {}", // 2
      "}", // 3
      "", // 4
      "function broken( {", // 5
      "  missing.close(;", // 6
      "}", // 7
      "", // 8
      "export class After {", // 9
      "  stop(): void {}", // 10
      "}", // 11
      "",
    ].join("\n");
    const result = facts(broken, "src/broken.ts");
    expect(result.symbols.map((s) => [s.qualifiedName, s.exported])).toEqual([
      ["Before", true],
      ["After", true],
    ]);
    expect(result.symbols.map((s) => s.members.map((m) => m.qualifiedName))).toEqual([
      ["Before.run"],
      ["After.stop"],
    ]);

    const diagnostics = parseErrorDiagnostics(result);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "CS0901",
      severity: "warning",
      codeLocation: { file: "src/broken.ts", line: 5, column: 1 },
    });
  });

  it("gives overload signatures an arity suffix and keeps the plain id for the one with a body", () => {
    const ids = (text: string): string[] =>
      facts(text).symbols.flatMap((s) => [s.id, ...s.members.map((m) => m.id)]);
    // A static and an instance method of the same name are not overloads.
    expect(ids("class C {\n  static m(a: number) {}\n  m() {}\n}\n")).toEqual([
      "src/file.ts#C",
      "src/file.ts#C.m",
      "src/file.ts#C.m",
    ]);
    // Without an implementation every signature is suffixed.
    expect(ids("declare function f(a: string): void;\ndeclare function f(): void;\n")).toEqual([
      "src/file.ts#f(1)",
      "src/file.ts#f(0)",
    ]);
    // The implementation is the one with a body, wherever it is.
    expect(ids("function f(): void;\nfunction f(a?: string) {}\n")).toEqual([
      "src/file.ts#f(0)",
      "src/file.ts#f",
    ]);
  });

  it("does not count a `this` parameter", () => {
    const [f] = facts("function f(this: Window, a: string) {}\n").symbols;
    expect(f!.params?.map((p) => p.name)).toEqual(["a"]);
  });

  it("reads a const arrow function exported by a later export list, and skips unexported ones", () => {
    const { symbols, calls } = facts("const f = () => g();\nconst h = () => 1;\nexport { f };\n");
    expect(symbols.map((s) => [s.id, s.kind, s.exported])).toEqual([
      ["src/file.ts#f", "function", true],
    ]);
    expect(calls).toMatchObject([{ callee: "g", enclosing: "src/file.ts#f" }]);
  });

  it("uses the TSX grammar for .tsx files", () => {
    const tsx = "export const App = () => <div>{greet()}</div>;\n";
    expect(facts(tsx, "src/App.tsx").parseErrors).toEqual([]);
    expect(facts(tsx, "src/App.tsx").calls.map((c) => c.callee)).toEqual(["greet"]);
    expect(facts(tsx, "src/App.ts").parseErrors).not.toEqual([]);
  });

  it("normalises types written in TypeScript syntax", () => {
    expect(adapter.normalizeType("readonly string[]").text).toBe("Array<string>");
    expect(adapter.normalizeType("Map< string , User[] >")).toEqual({
      text: "Map<string, Array<User>>",
      name: ["Map"],
      args: [
        { text: "string", name: ["string"], args: [] },
        {
          text: "Array<User>",
          name: ["Array"],
          args: [{ text: "User", name: ["User"], args: [] }],
        },
      ],
    });
    expect(adapter.normalizeType("string | null")).toEqual({
      text: "string|null",
      name: [],
      args: [],
    });
  });

  it("qualifies a symbol by its qualified name and needs load() before extract()", () => {
    const [symbol] = facts("namespace A { export class B {} }\n").symbols[0]!.members;
    expect(adapter.qualify(symbol!)).toBe("A.B");
    expect(() => new TypeScriptAdapter().extract(source("src/a.ts", ""))).toThrow(
      "the TypeScript adapter is not loaded",
    );
  });
});
