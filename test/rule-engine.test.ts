/**
 * The rule engine of F3 (`binding-resolver`, `contract-evaluator`, `structural-rules`,
 * `query-and-test-rules`, `architecture-rules`, `status-and-waivers`) on small repositories,
 * with the TypeScript adapter the CLI injects.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  checkCode,
  loadConfig,
  loadSpecModel,
  runTestCommand,
  type CheckOptions,
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

/** Checks a repository made of `files` (an ADR log without rules is added unless given). */
async function check(
  files: Record<string, string>,
  options: CheckOptions & { runTests?: boolean } = {},
): Promise<CheckResult & { dir: string }> {
  const repo = await createRepo({ [ADR_LOG]: adrLogText(), ...files }, { git: true });
  repos.push(repo);
  const { config, root } = await loadConfig(repo.dir);
  const model = await loadSpecModel(root, config);
  const codebase = await loadCodebase(root, config);
  const { runTests, ...rest } = options;
  const command = config.tests.command;
  const result = await checkCode(model, codebase, {
    ...rest,
    ...(runTests && command ? { runTest: (s: string) => runTestCommand(root, command, s) } : {}),
  });
  return { ...result, dir: repo.dir };
}

const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => d.code);
const only = (diagnostics: Diagnostic[], code: string): Diagnostic[] =>
  diagnostics.filter((d) => d.code === code);

/** A feature spec with `frontmatter` YAML lines after the required keys. */
const spec = (id: string, status: string, frontmatter: string): string =>
  specText(id, { status, extra: frontmatter });

const AUTH_SPEC = (status = "implemented", file = "src/services/AuthService.ts"): string =>
  spec(
    "auth",
    status,
    `bindings:
  - id: auth
    symbol: AuthService
    kind: class
    file: ${file}
    members: [login]
`,
  );

describe("PBI binding-resolver", () => {
  it("[AC-binding-resolver-1] resolves a binding whose file moved, without errors", async () => {
    const result = await check({
      "docs/spec/auth/auth.spec.md": AUTH_SPEC(),
      "src/auth/AuthService.ts": "export class AuthService { login() {} }\n",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved.get("auth")?.get("auth")?.file.path).toBe("src/auth/AuthService.ts");
    expect(result.items).toEqual([
      { spec: "auth", item: "binding:auth", enforceable: true, passed: true },
      { spec: "auth", item: "binding:auth.login", enforceable: true, passed: true },
    ]);
  });

  it("[AC-binding-resolver-2] reports CS0202 with both locations for two classes of one name", async () => {
    const result = await check({
      "docs/spec/auth/auth.spec.md": spec(
        "auth",
        "implemented",
        "bindings:\n  - symbol: AuthService\n    kind: class\n",
      ),
      "src/a/AuthService.ts": "export class AuthService {}\n",
      "src/b/AuthService.ts": "\nexport class AuthService {}\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0202"]);
    expect(result.diagnostics[0]!.message).toContain("src/a/AuthService.ts:1:14");
    expect(result.diagnostics[0]!.message).toContain("src/b/AuthService.ts:2:14");
  });

  it("reports CS0201 with close names of the same kind, the hinted file first", async () => {
    const result = await check({
      "docs/spec/auth/auth.spec.md": AUTH_SPEC("implemented", "src/auth.ts"),
      "src/auth.ts": "export class AuthServce {}\n",
      "src/other.ts": "export class AuthServices {}\nexport function AuthService2() {}\n",
    });
    const [notFound] = only(result.diagnostics, "CS0201");
    expect(notFound!.message).toBe(
      'binding "auth": class AuthService not found in src/auth.ts or anywhere else',
    );
    expect(notFound!.suggestions?.map((s) => s.message)).toEqual([
      "did you mean AuthServce? (src/auth.ts:1:14)",
      "did you mean AuthServices? (src/other.ts:1:14)",
    ]);
  });
});

describe("PBI contract-evaluator", () => {
  const contract = (bindingYaml: string, code: string, status = "implemented") =>
    check({
      "docs/spec/auth/auth.spec.md": spec("auth", status, `bindings:\n${bindingYaml}`),
      "src/auth.ts": code,
    });

  it("[AC-contract-evaluator-1] reports CS0205 for a return type mismatch with expected and found", async () => {
    const result = await contract(
      `  - id: auth
    symbol: AuthService
    members:
      - name: validateToken
        params: [string]
        returns: Promise<boolean>
`,
      "export class AuthService {\n  validateToken(token: string): boolean { return true; }\n}\n",
    );
    expect(codes(result.diagnostics)).toEqual(["CS0205"]);
    const [mismatch] = result.diagnostics;
    expect(mismatch!.message).toContain("returns: expected Promise<boolean>, found boolean");
    expect(mismatch!.item).toBe("binding:auth.validateToken");
    expect(mismatch!.codeLocation).toMatchObject({ file: "src/auth.ts", line: 2, column: 3 });
  });

  it("[AC-contract-evaluator-2] reports CS0207 for a missing constructor dependency", async () => {
    const result = await contract(
      `  - symbol: Handler
    constructor:
      requires: [ILogger, IEventStore]
`,
      'import type { ILogger } from "./log";\nexport class Handler {\n  constructor(private log: ILogger) {}\n}\n',
    );
    expect(codes(result.diagnostics)).toEqual(["CS0207"]);
    expect(result.diagnostics[0]!.message).toContain("IEventStore missing");
    expect(result.diagnostics[0]!.expected).toBe("IEventStore");
  });

  it("[AC-contract-evaluator-3] reports CS0220 with the configured severity, not CS0204, for a base that is an alias", async () => {
    const files = {
      "docs/spec/h/h.spec.md": spec(
        "handler",
        "implemented",
        "bindings:\n  - symbol: Handler\n    implements: [IHandler]\n",
      ),
      "src/types.ts": "export interface IHandler {}\nexport type Base = IHandler;\n",
      "src/handler.ts":
        'import type { Base } from "./types";\nexport class Handler implements Base {}\n',
    };
    const warn = await check(files);
    expect(codes(warn.diagnostics)).toEqual(["CS0220"]);
    expect(warn.diagnostics[0]!.severity).toBe("warning");

    const strict = await check({
      ...files,
      "catspec.yaml": "enforcement:\n  unresolvable: error\n",
    });
    expect(codes(strict.diagnostics)).toEqual(["CS0220"]);
    expect(strict.diagnostics[0]!.severity).toBe("error");
  });

  it("checks kind, export, bases, decorators, members, modifiers and optional members", async () => {
    const result = await contract(
      `  - id: svc
    symbol: Service
    kind: class
    exported: true
    implements: [IService]
    extends: Base
    attributes: ['Injectable("root")']
    members:
      - { name: run, kind: method, params: [string, number], returns: void, modifiers: [public, async] }
      - { name: helper, modifiers: [public] }
      - { name: name, kind: field }
      - { name: maybe, optional: true }
`,
      `import { IService as Contract } from "./contracts";
@Injectable('root')
export class Service extends Base implements Contract {
  name = "x";
  async run(a, b: number): void {}
  private helper() {}
}
`,
    );
    expect(result.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([
      "CS0220 can't check member run from syntax: parameter a has no type",
      "CS0208 member helper visibility mismatch: modifier public missing",
    ]);
  });
});

describe("PBI structural-rules", () => {
  it("[AC-structural-rules-1] reports a forbidden call only inside the bound class", async () => {
    const result = await check({
      "docs/spec/auth/auth.spec.md": spec(
        "auth",
        "implemented",
        `bindings:
  - id: auth
    symbol: AuthService
rules:
  - id: no-console
    class: structural
    forbid_call: "console.*"
    within: auth
`,
      ),
      "src/auth.ts":
        'export class AuthService {\n  login() { console.log("in"); }\n}\nexport class Other {\n  run() { console.log("out"); }\n}\n',
    });
    expect(codes(result.diagnostics)).toEqual(["CS0601"]);
    expect(result.diagnostics[0]!.codeLocation).toMatchObject({ file: "src/auth.ts", line: 2 });
    expect(result.diagnostics[0]!.item).toBe("rule:no-console");
  });

  it("[AC-structural-rules-2] reports CS0604 for a class that breaks a naming rule", async () => {
    const result = await check({
      "docs/spec/h/h.spec.md": spec(
        "handler",
        "implemented",
        `scope: ["src/**"]
rules:
  - id: handlers
    class: structural
    naming:
      kind: class
      name: "*Handler"
      implements: ["IMessageHandler<*>"]
`,
      ),
      "src/handlers.ts":
        "export class UserHandler {}\nexport class OrderHandler implements Bus.IMessageHandler<Order> {}\nexport class Helper {}\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0604"]);
    expect(result.diagnostics[0]!.message).toContain(
      "class UserHandler must implement IMessageHandler<*>",
    );
  });

  it("checks require_call, allow_import_only, must_not_exist, paths and calls through imports", async () => {
    const result = await check({
      "docs/spec/r/r.spec.md": spec(
        "rules",
        "implemented",
        `scope: ["src/**"]
rules:
  - id: audit
    class: structural
    require_call: "audit"
  - id: only-shared
    class: structural
    allow_import_only: { from: "src/app/**", to: ["src/shared/**"] }
  - id: no-old-api
    class: structural
    must_not_exist: { symbol: "Legacy*", kind: class }
  - id: no-exec
    class: structural
    forbid_call: "child_process.exec*"
    paths: ["src/app/**"]
`,
      ),
      "src/app/main.ts": `import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { util } from "../shared/util";
import { db } from "../infra/db.js";
export class LegacyService {}
execSync("ls");
`,
      "src/shared/util.ts": 'import { exec } from "node:child_process";\nexec("ls");\n',
    });
    expect(
      result.diagnostics.map((d) => `${d.code} ${d.ruleId} ${d.codeLocation?.line ?? "-"}`),
    ).toEqual([
      "CS0602 audit -",
      "CS0603 only-shared 4",
      "CS0605 no-old-api 5",
      "CS0601 no-exec 6",
    ]);
  });
});

describe("PBI query-and-test-rules", () => {
  it("runs a query rule within a binding", async () => {
    const result = await check({
      "docs/spec/q/q.spec.md": spec(
        "queries",
        "implemented",
        `bindings:
  - id: svc
    symbol: Service
rules:
  - id: no-any
    class: query
    lang: typescript
    query: '((predefined_type) @hit (#eq? @hit "any"))'
    within: svc
  - id: has-method
    class: query
    lang: typescript
    expect: present
    query: "(method_definition name: (property_identifier) @hit (#eq? @hit \\"dispose\\"))"
    within: svc
`,
      ),
      "src/svc.ts":
        "export class Service {\n  run(x: any) {}\n}\nexport function free(y: any) {}\n",
    });
    expect(
      result.diagnostics.map((d) => `${d.code} ${d.ruleId} ${d.codeLocation?.line ?? "-"}`),
    ).toEqual(["CS0610 no-any 2", "CS0610 has-method -"]);
  });

  it("[AC-query-and-test-rules-2] reports CS0620 naming a missing linked test", async () => {
    const result = await check({
      "docs/spec/t/t.spec.md": spec(
        "tests",
        "implemented",
        `rules:
  - id: idempotent
    class: test
    test: { symbol: UserUpdatedHandlerTests.HandleAsync_IsIdempotent }
`,
      ),
      "src/handler.test.ts":
        "export class UserUpdatedHandlerTests {\n  HandleAsync_Works() {}\n}\n",
    });
    expect(codes(result.diagnostics)).toEqual(["CS0620"]);
    expect(result.diagnostics[0]!.message).toContain(
      "test UserUpdatedHandlerTests.HandleAsync_IsIdempotent",
    );
  });

  it("[AC-query-and-test-rules-3] runs a failing test only with --run-tests and then reports CS0621", async () => {
    const files = {
      "catspec.yaml": 'tests:\n  command: ["node", "run-test.mjs", "{test}"]\n',
      "run-test.mjs":
        'import { writeFileSync } from "node:fs";\nwriteFileSync("ran.txt", process.argv[2]);\nprocess.exit(1);\n',
      "docs/spec/t/t.spec.md": spec(
        "tests",
        "implemented",
        "rules:\n  - id: idempotent\n    class: test\n    test: { symbol: HandlerTests.IsIdempotent }\n",
      ),
      "src/handler.test.ts": "export class HandlerTests {\n  IsIdempotent() {}\n}\n",
    };
    const without = await check(files);
    expect(without.diagnostics).toEqual([]);
    expect(existsSync(join(without.dir, "ran.txt"))).toBe(false);

    const withTests = await check(files, { runTests: true });
    expect(codes(withTests.diagnostics)).toEqual(["CS0621"]);
    expect(withTests.diagnostics[0]!.message).toContain(
      "node run-test.mjs HandlerTests.IsIdempotent",
    );
    expect(existsSync(join(withTests.dir, "ran.txt"))).toBe(true);
  });
});

describe("PBI architecture-rules", () => {
  const rules = `rules:
  - id: domain-no-infrastructure
    adr: ADR-001
    class: structural
    forbid_import:
      from: "src/Domain/**"
      to: ["src/Infrastructure/**"]
`;
  const code = {
    "src/Domain/User.ts": 'import { Db } from "../Infrastructure/Db";\nexport class User {}\n',
    "src/Infrastructure/Db.ts": "export class Db {}\n",
  };

  it("[AC-architecture-rules-1] reports CS0603 for any Domain file, bound by a spec or not (spec AC-6)", async () => {
    const result = await check({
      [ADR_LOG]: adrLogText(["ADR-001"], rules).replace("status: draft", "status: implemented"),
      ...code,
    });
    expect(codes(result.diagnostics)).toEqual(["CS0603"]);
    expect(result.diagnostics[0]!.codeLocation).toMatchObject({
      file: "src/Domain/User.ts",
      line: 1,
    });
    expect(result.diagnostics[0]!.severity).toBe("error");
  });

  it("[AC-architecture-rules-2] doesn't enforce a draft architecture spec", async () => {
    const result = await check({ [ADR_LOG]: adrLogText(["ADR-001"], rules), ...code });
    expect(result.diagnostics).toEqual([]);
  });
});

describe("PBI status-and-waivers", () => {
  it("doesn't check draft, ready or deprecated specs", async () => {
    for (const status of ["draft", "ready", "deprecated"]) {
      const result = await check({
        "docs/spec/auth/auth.spec.md": AUTH_SPEC(status),
        "src/auth.ts": "export class Other {}\n",
      });
      expect(result.diagnostics, status).toEqual([]);
      expect(result.checked, status).toEqual([]);
    }
  });

  it("[AC-status-and-waivers-2] reports an expired waiver as CS0401 and the violation again", async () => {
    const files = {
      "docs/spec/auth/auth.spec.md": spec(
        "auth",
        "implemented",
        `bindings:
  - id: auth
    symbol: AuthService
rules:
  - id: no-console
    class: structural
    forbid_call: "console.*"
    within: auth
waivers:
  - rule: no-console
    reason: Bootstrap logging
    until: 2026-01-01
`,
      ),
      "src/auth.ts": 'export class AuthService {\n  login() { console.log("in"); }\n}\n',
    };
    const active = await check(files, { now: new Date(2025, 11, 31) });
    expect(active.diagnostics.map((d) => [d.code, d.severity])).toEqual([["CS0400", "info"]]);
    expect(active.items.find((i) => i.item === "rule:no-console")?.passed).toBe(true);

    const expired = await check(files, { now: new Date(2026, 0, 2) });
    expect(expired.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["CS0601", "error"],
      ["CS0401", "error"],
    ]);
  });
});
