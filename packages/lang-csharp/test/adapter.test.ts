import { gitBlobSha, typeMatches, type FileFacts, type SymbolFact } from "@catspec/core";
import { beforeAll, describe, expect, it } from "vitest";

import { CSharpAdapter } from "../src/index.js";

const adapter = new CSharpAdapter();
beforeAll(() => adapter.load());

const facts = (text: string, path = "src/File.cs"): FileFacts =>
  adapter.extract({ path, text, blobSha: gitBlobSha(text) });

/** The symbol with this qualified name, at any depth. */
function find(symbols: SymbolFact[], qualifiedName: string): SymbolFact {
  for (const symbol of symbols) {
    if (symbol.qualifiedName === qualifiedName) return symbol;
    const nested = symbol.members.length > 0 ? tryFind(symbol.members, qualifiedName) : undefined;
    if (nested) return nested;
  }
  throw new Error(`no symbol ${qualifiedName}`);
}
const tryFind = (symbols: SymbolFact[], name: string): SymbolFact | undefined => {
  try {
    return find(symbols, name);
  } catch {
    return undefined;
  }
};

const paramTypes = (symbol: SymbolFact): (string | undefined)[] =>
  (symbol.params ?? []).map((p) => p.type?.text);

describe("C# adapter: declarations (PBI csharp-declarations)", () => {
  it('[AC-csharp-declarations-1] gives Identity.Handlers.UserUpdatedHandler for "namespace Identity.Handlers;" followed by class UserUpdatedHandler', () => {
    const { symbols } = facts(
      "namespace Identity.Handlers;\n\npublic class UserUpdatedHandler { }\n",
    );
    expect(symbols.map((s) => s.qualifiedName)).toEqual(["Identity.Handlers.UserUpdatedHandler"]);
    expect(symbols[0]!.id).toBe("src/File.cs#Identity.Handlers.UserUpdatedHandler");
  });

  it('[AC-csharp-declarations-2] turns "public class Handler(ILogger log, IEventStore store)" into a constructor taking ILogger and IEventStore', () => {
    const [handler] = facts("public class Handler(ILogger log, IEventStore store) { }\n").symbols;
    const constructors = handler!.members.filter((m) => m.kind === "constructor");
    expect(constructors).toHaveLength(1);
    expect(constructors[0]!.params?.map((p) => [p.type?.text, p.name])).toEqual([
      ["ILogger", "log"],
      ["IEventStore", "store"],
    ]);
  });

  it("qualifies types by block namespaces, nested namespaces and enclosing types", () => {
    const { symbols } = facts(
      "namespace A.B {\n  namespace C {\n    class Outer { struct Inner { } }\n  }\n}\nclass Global { }\n",
    );
    expect(symbols.map((s) => s.qualifiedName)).toEqual(["A.B.C.Outer", "Global"]);
    expect(find(symbols, "A.B.C.Outer.Inner").kind).toBe("struct");
  });

  it("extracts every kind of type declaration", () => {
    const { symbols } = facts(
      [
        "namespace N;",
        "public class C { }",
        "public struct S { }",
        "public interface I { }",
        "public record R(int X);",
        "public record struct RS(int X);",
        "public enum E { A, B = 2 }",
        "public delegate Task D(int value);",
      ].join("\n"),
    );
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([
      ["C", "class"],
      ["S", "struct"],
      ["I", "interface"],
      ["R", "record"],
      ["RS", "record"],
      ["E", "enum"],
      ["D", "type"],
    ]);
    expect(find(symbols, "N.E").members.map((m) => [m.name, m.kind])).toEqual([
      ["A", "field"],
      ["B", "field"],
    ]);
    expect(find(symbols, "N.D")).toMatchObject({ returns: { text: "Task" } });
    expect(paramTypes(find(symbols, "N.D"))).toEqual(["Int32"]);
  });

  it("extracts methods, properties, fields, events and constructors with their types", () => {
    const { symbols } = facts(`class Service {
  public Service(ILogger log) { }
  static Service() { }
  public async Task<int> RunAsync(string name, CancellationToken ct = default) => 1;
  public string? Name { get; set; }
  private readonly int _a, _b;
  public event EventHandler Changed;
  public event EventHandler Closed { add { } remove { } }
  public static Service operator +(Service a, Service b) => a;
  public int this[int i] => i;
  ~Service() { }
}
`);
    const service = symbols[0]!;
    expect(service.members.map((m) => [m.name, m.kind])).toEqual([
      ["Service", "constructor"],
      ["Service", "constructor"],
      ["RunAsync", "method"],
      ["Name", "property"],
      ["_a", "field"],
      ["_b", "field"],
      ["Changed", "event"],
      ["Closed", "event"],
    ]);
    const run = find(symbols, "Service.RunAsync");
    expect(run.modifiers).toEqual(["public", "async"]);
    expect(run.returns?.text).toBe("Task<Int32>");
    expect(run.params).toEqual([
      {
        name: "name",
        type: { text: "String", name: ["String"], args: [] },
        modifiers: [],
        attributes: [],
      },
      {
        name: "ct",
        type: { text: "CancellationToken", name: ["CancellationToken"], args: [] },
        modifiers: [],
        optional: true,
        attributes: [],
      },
    ]);
    expect(find(symbols, "Service.Name").returns?.text).toBe("Nullable<String>");
    expect(find(symbols, "Service._b")).toMatchObject({
      modifiers: ["private", "readonly"],
      returns: { text: "Int32" },
    });
    expect(find(symbols, "Service.Changed").returns?.text).toBe("EventHandler");
  });

  it("reads parameter modifiers and params arrays", () => {
    const [type] = facts(
      "static class X { public static void M(this string s, ref int a, out int b, in long c, params object[] rest) { } }",
    ).symbols;
    const params = type!.members[0]!.params!;
    expect(params.map((p) => [p.modifiers, p.type?.text, p.name, p.rest ?? false])).toEqual([
      [["this"], "String", "s", false],
      [["ref"], "Int32", "a", false],
      [["out"], "Int32", "b", false],
      [["in"], "Int64", "c", false],
      [["params"], "Array<Object>", "rest", true],
    ]);
  });

  it("makes the positional parameters of a record public properties", () => {
    const { symbols } = facts(
      'public record User(Guid Id, string? Email) { public string Email { get; init; } = ""; }\n',
    );
    const user = symbols[0]!;
    expect(user.members.map((m) => [m.name, m.kind, m.returns?.text])).toEqual([
      ["User", "constructor", undefined],
      ["Email", "property", "String"],
      ["Id", "property", "Guid"],
    ]);
    expect(paramTypes(user.members[0]!)).toEqual(["Guid", "Nullable<String>"]);
  });

  it("gives overloads ids with their arity, and a number when arities repeat", () => {
    const { symbols } = facts(`class X {
  public X() { }
  public X(int a) { }
  void M(int a) { }
  void M(string a) { }
  void M() { }
  void Single() { }
}
`);
    expect(symbols[0]!.members.map((m) => m.id)).toEqual([
      "src/File.cs#X.X(0)",
      "src/File.cs#X.X(1)",
      "src/File.cs#X.M(1)#1",
      "src/File.cs#X.M(1)#2",
      "src/File.cs#X.M(0)",
      "src/File.cs#X.Single",
    ]);
  });

  it("still reads declarations around a syntax error and reports the error", () => {
    const { symbols, parseErrors } = facts(
      "namespace N;\nclass Before { }\nclass Broken { void M( { }\nclass After { void Ok() { } }\n",
    );
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(symbols.map((s) => s.qualifiedName)).toContain("N.Before");
    expect(symbols.some((s) => s.qualifiedName.endsWith("After"))).toBe(true);
  });
});

describe("C# adapter: attributes, bases, imports and calls (PBI csharp-attributes-bases-imports)", () => {
  it("reads modifiers including partial, async and override, and attributes with argument text", () => {
    const { symbols } = facts(`[ApiController, Route("api/[controller]")]
public sealed partial class UsersController : ControllerBase {
  [HttpGet("users")]
  [ProducesResponseType(typeof(User), StatusCodes.Status200OK)]
  public override async Task<IActionResult> Get([FromQuery] int page) => Ok();
}
`);
    const controller = symbols[0]!;
    expect(controller.modifiers).toEqual(["public", "sealed", "partial"]);
    expect(controller.partial).toBe(true);
    expect(controller.attributes.map((a) => [a.name, a.args])).toEqual([
      ["ApiController", []],
      ["Route", ['"api/[controller]"']],
    ]);
    const get = controller.members[0]!;
    expect(get.modifiers).toEqual(["public", "override", "async"]);
    expect(get.attributes.map((a) => [a.name, a.args])).toEqual([
      ["HttpGet", ['"users"']],
      ["ProducesResponseType", ["typeof(User)", "StatusCodes.Status200OK"]],
    ]);
    expect(get.params![0]!.attributes.map((a) => a.name)).toEqual(["FromQuery"]);
  });

  it("keeps the base list in source order, including record base arguments and generic bases", () => {
    const { symbols } = facts(
      "class A : Base, IHandler<Created>, global::System.IDisposable { }\nrecord B(int X) : Base(X), IX;\nclass C(int x) : Base(x) { }\n",
    );
    expect(symbols.map((s) => s.bases.map((b) => b.text))).toEqual([
      ["Base", "IHandler<Created>", "IDisposable"],
      ["Base", "IX"],
      ["Base"],
    ]);
  });

  it("records using and global using directives as imports of *, and aliases as * under the alias", () => {
    const { imports } = facts(
      "using System;\nglobal using static System.Math;\nusing Handler = Contracts.IMessageHandler<UserUpdatedEvent>;\nnamespace N { using Infrastructure.Persistence; }\n",
    );
    expect(imports.map((i) => [i.module, i.kind, i.names])).toEqual([
      ["System", "static", [{ name: "*" }]],
      ["System.Math", "static", [{ name: "*" }]],
      ["Contracts.IMessageHandler<UserUpdatedEvent>", "static", [{ name: "*", alias: "Handler" }]],
      ["Infrastructure.Persistence", "static", [{ name: "*" }]],
    ]);
    expect(imports[0]!.range).toEqual({
      start: { line: 1, column: 1 },
      end: { line: 1, column: 14 },
    });
  });

  it("replaces a using alias in a base type with what it names", () => {
    const { symbols } = facts(
      "using Handler = Contracts.IMessageHandler<UserUpdatedEvent>;\nusing Ns = Some.Namespace;\nclass X : Handler, Ns.IThing { }\n",
    );
    expect(symbols[0]!.bases.map((b) => b.text)).toEqual([
      "Contracts.IMessageHandler<UserUpdatedEvent>",
      "Some.Namespace.IThing",
    ]);
  });

  it("records invocations with their callee text and enclosing member", () => {
    const { calls } = facts(`class H {
  void Run() {
    Console.WriteLine("x");
    _store . SaveAsync(1);
    Generic<int>();
    a?.B();
  }
}
`);
    expect(calls.map((c) => [c.callee, c.enclosing])).toEqual([
      ["Console.WriteLine", "src/File.cs#H.Run"],
      ["_store.SaveAsync", "src/File.cs#H.Run"],
      ["Generic<int>", "src/File.cs#H.Run"],
      ["a?.B", "src/File.cs#H.Run"],
    ]);
  });
});

describe("C# adapter: type normalisation (PBI csharp-partials-and-types)", () => {
  it.each([
    ["Task", "System.Threading.Tasks.Task"],
    ["string?", "global::System.String?"],
  ])(
    '[AC-csharp-partials-and-types-1] matches the expected type "%s" against "%s"',
    (expected, found) => {
      expect(typeMatches(adapter.normalizeType(expected), adapter.normalizeType(found))).toBe(true);
      // The same spelling found in code.
      const [type] = facts(`class X { ${found} F; }`).symbols;
      expect(typeMatches(adapter.normalizeType(expected), type!.members[0]!.returns!)).toBe(true);
    },
  );

  it.each([
    ["int", "Int32"],
    ["System.Int32", "Int32"],
    ["global::System.Collections.Generic.List<int?>", "Collections.Generic.List<Nullable<Int32>>"],
    ["string[]", "Array<String>"],
    ["int[,]", "Int32[, ]"],
    ["(int id, string name)", "ValueTuple<Int32, String>"],
    ["Dictionary< string , List<int> >", "Dictionary<String, List<Int32>>"],
    ["not a type ((", "not a type(("],
  ])("normalises %s to %s", (text, normalised) => {
    expect(adapter.normalizeType(text).text).toBe(normalised);
  });

  it("tells types apart by generic arity and nullability", () => {
    const t = (text: string) => adapter.normalizeType(text);
    expect(typeMatches(t("Task"), t("Task<int>"))).toBe(false);
    expect(typeMatches(t("IHandler<A>"), t("IHandler<A, B>"))).toBe(false);
    expect(typeMatches(t("int"), t("int?"))).toBe(false);
    expect(typeMatches(t("Nullable<int>"), t("int?"))).toBe(true);
  });
});

describe("C# adapter: query rules (ADR-022)", () => {
  it("compiles queries and returns the ranges of @hit captures", () => {
    expect(adapter.checkQuery("(invocation_expression) @hit")).toBeUndefined();
    expect(adapter.checkQuery("(no_such_node) @hit")).toMatch(/./);
    const text = 'class X { void M() { Console.WriteLine("x"); } }';
    expect(
      adapter.runQuery(
        { path: "src/X.cs", text, blobSha: gitBlobSha(text) },
        "(invocation_expression) @hit",
      ),
    ).toEqual([{ start: { line: 1, column: 22 }, end: { line: 1, column: 44 } }]);
  });

  it("names its version after the facts format and the grammar", () => {
    expect(adapter.version).toBe("csharp-facts-2+tree-sitter-c-sharp@0.23.5");
    expect(adapter.extensions).toEqual([".cs"]);
  });
});

describe("C# adapter: type parameters", () => {
  it("reads the type parameters of generic types and methods", () => {
    const { symbols } = facts(
      "class Repo<T> { void M<U>() { } }\nstruct S<A, B> { }\nrecord R<T>(T Value);\ninterface I<in T> { }\n",
    );
    expect(symbols.map((s) => s.typeParams)).toEqual([["T"], ["A", "B"], ["T"], ["T"]]);
    expect(symbols[0]!.members[0]!.typeParams).toEqual(["U"]);
  });
});
