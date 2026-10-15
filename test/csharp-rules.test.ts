/**
 * The F3 rule engine on C# code (feature F4 `csharp-language-support`, PBIs
 * `csharp-attributes-bases-imports` and `csharp-partials-and-types`), with the adapters the CLI
 * injects.
 */
import {
  checkCode,
  loadConfig,
  loadSpecModel,
  type CheckResult,
  type Diagnostic,
} from "@catspec/core";
import { afterEach, describe, expect, it } from "vitest";

import { loadCodebase } from "../packages/cli/src/codebase.js";
import { ADR_LOG, adrLogText, createRepo, specText, type TempRepo } from "./temp-repo.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

async function check(files: Record<string, string>): Promise<CheckResult> {
  const repo = await createRepo({ [ADR_LOG]: adrLogText(), ...files }, { git: true });
  repos.push(repo);
  const { config, root } = await loadConfig(repo.dir);
  return checkCode(await loadSpecModel(root, config), await loadCodebase(root, config));
}

const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => d.code);

/** An implemented spec with one binding; `binding` is YAML under `- id: x`. */
const bindingSpec = (binding: string, rules = ""): string =>
  specText("csharp-binding", {
    status: "implemented",
    extra: `bindings:\n  - id: x\n${binding}${rules}`,
  });

describe("C# attributes and using aliases (PBI csharp-attributes-bases-imports)", () => {
  const controller = `namespace Api;

public class UsersController {
    [HttpGet("users")]
    public string List() => "";
}
`;
  const spec = (attribute: string): string =>
    bindingSpec(`    symbol: Api.UsersController
    kind: class
    members:
      - name: List
        kind: method
        attributes: ['${attribute}']
`);

  it('[AC-csharp-attributes-bases-imports-1] passes a method with [HttpGet("users")] against attribute HttpGet("users"), fails HttpGet("accounts") with CS0206', async () => {
    const pass = await check({
      "docs/spec/api/csharp-binding.spec.md": spec('HttpGet("users")'),
      "src/Api/UsersController.cs": controller,
    });
    expect(codes(pass.diagnostics)).toEqual([]);

    const fail = await check({
      "docs/spec/api/csharp-binding.spec.md": spec('HttpGet("accounts")'),
      "src/Api/UsersController.cs": controller,
    });
    expect(codes(fail.diagnostics)).toEqual(["CS0206"]);
    expect(fail.diagnostics[0]!.message).toContain('attribute HttpGet("accounts") missing');
  });

  it('[AC-csharp-attributes-bases-imports-2] resolves "using Handler = Contracts.IMessageHandler<UserUpdatedEvent>;" in "class X : Handler"', async () => {
    const result = await check({
      "docs/spec/sync/csharp-binding.spec.md": bindingSpec(`    symbol: X
    kind: class
    implements: ["IMessageHandler<UserUpdatedEvent>"]
`),
      "src/X.cs":
        "using Handler = Contracts.IMessageHandler<UserUpdatedEvent>;\n\nclass X : Handler { }\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("checks extends against the first base of a class only", async () => {
    const code = { "src/X.cs": "class X : Base, IFoo { }\n" };
    const extendsBase = await check({
      "docs/spec/x/csharp-binding.spec.md": bindingSpec("    symbol: X\n    extends: Base\n"),
      ...code,
    });
    expect(codes(extendsBase.diagnostics)).toEqual([]);
    const extendsInterface = await check({
      "docs/spec/x/csharp-binding.spec.md": bindingSpec("    symbol: X\n    extends: IFoo\n"),
      ...code,
    });
    expect(codes(extendsInterface.diagnostics)).toEqual(["CS0204"]);
  });
});

describe("C# partial classes (PBI csharp-partials-and-types)", () => {
  const parts = (method: string): Record<string, string> => ({
    "src/Handlers/Handler.cs":
      "namespace H;\n\npublic partial class Handler(ILogger log) : IHandler { }\n",
    "src/Handlers/Handler.Run.cs": `namespace H;

public partial class Handler {
    public void ${method}() {
        Console.WriteLine("run");
    }
}
`,
  });

  it("checks members, constructor and bases over every part", async () => {
    const result = await check({
      "docs/spec/h/csharp-binding.spec.md": bindingSpec(`    symbol: H.Handler
    kind: class
    file: src/Handlers/*.cs
    implements: [IHandler]
    constructor:
      requires: [ILogger]
    members: [Run]
`),
      ...parts("Run"),
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("points did-you-mean at the part that declares the member", async () => {
    const result = await check({
      "docs/spec/h/csharp-binding.spec.md": bindingSpec(`    symbol: H.Handler
    file: src/Handlers/*.cs
    members: [Run]
`),
      ...parts("RunNow"),
    });
    expect(codes(result.diagnostics)).toEqual(["CS0203"]);
    expect(result.diagnostics[0]!.suggestions?.[0]?.message).toBe(
      "did you mean RunNow? (src/Handlers/Handler.Run.cs:4:17)",
    );
  });

  it("applies a rule within the binding to every part", async () => {
    const result = await check({
      "docs/spec/h/csharp-binding.spec.md": bindingSpec(
        "    symbol: H.Handler\n    file: src/Handlers/*.cs\n",
        `rules:
  - id: no-console
    class: structural
    forbid_call: Console.WriteLine
    within: x
`,
      ),
      ...parts("Run"),
    });
    expect(codes(result.diagnostics)).toEqual(["CS0601"]);
    expect(result.diagnostics[0]!.codeLocation?.file).toBe("src/Handlers/Handler.Run.cs");
  });
});

/** Findings of the PR #10 review, each reproduced on a small repository. */
describe("C# review findings", () => {
  const spec = (binding: string, rules = ""): Record<string, string> => ({
    "docs/spec/x/csharp-binding.spec.md": bindingSpec(binding, rules),
  });

  it("extends: finds the base class on a later partial part", async () => {
    const result = await check({
      ...spec("    symbol: H\n    extends: Base\n"),
      "src/H.cs": "partial class H : IFoo { }\n",
      "src/H2.cs": "partial class H : Base { }\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("extends: an interface-named first base or a struct base isn't a base class", async () => {
    const onClass = await check({
      ...spec("    symbol: H\n    extends: IFoo\n"),
      "src/H.cs": "class H : IFoo { }\n",
    });
    expect(codes(onClass.diagnostics)).toEqual(["CS0204"]);
    const onStruct = await check({
      ...spec("    symbol: S\n    extends: Base\n"),
      "src/S.cs": "struct S : Base { }\n",
    });
    expect(codes(onStruct.diagnostics)).toEqual(["CS0204"]);
  });

  it("partial parts in one file are merged, not collapsed", async () => {
    const result = await check({
      ...spec("    symbol: H\n    members: [A, B]\n"),
      "src/H.cs": "partial class H { void A() { } }\npartial class H { void B() { } }\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("two non-partial types with one name in one file are ambiguous", async () => {
    const result = await check({
      ...spec("    symbol: Result\n"),
      "src/Result.cs": "class Result { }\nclass Result<T> { }\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0202"]);
  });

  it("using aliases apply to parameter, return and property types", async () => {
    const result = await check({
      ...spec(`    symbol: H
    constructor:
      requires: [ILogger]
    members:
      - { name: Get, returns: ILogger }
`),
      "src/H.cs":
        "using Log = Microsoft.Extensions.Logging.ILogger;\nclass H { public H(Log log) { } public Log Get() => null; }\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("a using alias inside a namespace applies only inside it", async () => {
    const result = await check({
      ...spec("    symbol: B.X\n    implements: [IFoo]\n"),
      "src/X.cs":
        "namespace A { using H = Lib.IFoo; class X : H { } }\nnamespace B { class X : H { } }\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0204"]);
  });

  it("a binding to an overloaded method is ambiguous", async () => {
    const result = await check({
      ...spec("    symbol: H.M\n    kind: method\n"),
      "src/H.cs": "class H { void M() { } void M(int a) { } }\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0202"]);
  });

  it("a partial method split over two files is one method", async () => {
    const result = await check({
      ...spec("    symbol: H.M\n    kind: method\n"),
      "src/H.cs": "partial class H { partial void M(); }\n",
      "src/H2.cs": "partial class H { partial void M() { } }\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("applies C#'s implicit visibility to members", async () => {
    const result = await check({
      ...spec(`    symbol: H
    members:
      - { name: Hidden, modifiers: [private] }
`),
      "src/H.cs": "class H { void Hidden() { } }\n",
      "docs/spec/y/interface-binding.spec.md": specText("interface-binding", {
        status: "implemented",
        extra: `bindings:
  - id: i
    symbol: IFoo
    kind: interface
    members:
      - { name: Run, modifiers: [public] }
`,
      }),
      "src/IFoo.cs": "interface IFoo { void Run(); }\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("forbid_call sees System-qualified, global:: and using-static calls", async () => {
    const rule = `rules:
  - id: no-console
    class: structural
    forbid_call: Console.WriteLine
`;
    const result = await check({
      ...spec("    symbol: H\n", rule),
      "src/H.cs": `using static System.Console;
class H {
  void A() { System.Console.WriteLine(1); }
  void B() { global::System.Console.WriteLine(2); }
  void C() { WriteLine(3); }
}
`,
    });
    expect(codes(result.diagnostics)).toEqual(["CS0601", "CS0601", "CS0601"]);
    const qualified = await check({
      ...spec("    symbol: H\n", rule.replace("Console.WriteLine", "System.Console.WriteLine")),
      "src/H.cs": "using System;\nclass H { void A() { Console.WriteLine(1); } }\n",
    });
    expect(codes(qualified.diagnostics)).toEqual(["CS0601"]);
  });

  it("bases are resolved through the imports of the part that declares them", async () => {
    const result = await check({
      ...spec("    symbol: H\n    implements: [IReal]\n"),
      "src/H.cs": "partial class H : Fake { }\n",
      "src/H2.cs": "using Fake = IReal;\npartial class H { }\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0204"]);
  });

  it("allow_import_only doesn't flag System namespaces", async () => {
    const result = await check({
      [ADR_LOG]: adrLogText(
        ["ADR-001"],
        `rules:
  - id: domain-only
    adr: ADR-001
    class: structural
    allow_import_only:
      from: "src/Domain/**"
      to: ["Domain.*"]
`,
      ).replace("status: draft", "status: implemented"),
      "src/Domain/User.cs": "using System.Linq;\nusing System;\nnamespace Domain; class User { }\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it("must_not_exist without a kind doesn't report constructors", async () => {
    const result = await check({
      ...spec(
        "    symbol: Keep\n",
        `rules:
  - id: no-legacy
    class: structural
    must_not_exist: { symbol: Legacy }
`,
      ),
      "src/Keep.cs": "class Keep { }\nclass Legacy { public Legacy() { } }\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0605"]);
  });
});

describe("TypeScript overloads stay one declaration", () => {
  it("binds an interface method with only overload signatures", async () => {
    const result = await check({
      "docs/spec/x/csharp-binding.spec.md": bindingSpec("    symbol: Api.call\n    kind: method\n"),
      "src/api.ts":
        "export interface Api {\n  call(a: string): void;\n  call(a: string, b: number): void;\n}\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
  });
});
