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
