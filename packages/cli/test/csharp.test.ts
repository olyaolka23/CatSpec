/**
 * `catspec check` on C# code end to end (feature F4 `csharp-language-support`, PBI
 * `csharp-acceptance`), on the "microservice" fixture built from the requirements' example
 * (plan §D5.1). The fixture holds the code; the spec and the ADR log are written by the test,
 * because Markdown files in the repository need the owner's approval (AGENTS.md Rule 3).
 */
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturesDir, loadFixture, type LoadedFixture } from "../../../test/fixtures.js";
import { writeFiles } from "../../../test/temp-repo.js";
import { run } from "../src/index.js";

const fixtures: LoadedFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function catspec(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    cwd,
    env: {},
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

const HANDLER_DIR = "src/Services/Identity/Handlers";

/** The requirements' spec (plan §D5.1), without its test rule and dependency. */
const USER_SYNC_SPEC = `---
catspec: 1
id: user-sync-handler
title: User sync handler
type: feature
status: implemented
scope:
  - ${HANDLER_DIR}/**
bindings:
  - id: handler
    symbol: Identity.Handlers.UserUpdatedHandler
    kind: class
    file: ${HANDLER_DIR}/*.cs
    implements: ["IMessageHandler<UserUpdatedEvent>"]
    constructor:
      requires: [ILogger, IEventStore]
    members:
      - name: HandleAsync
        kind: method
        params: [UserUpdatedEvent, CancellationToken]
        returns: Task
        modifiers: [public]
rules:
  - id: no-console
    class: structural
    forbid_call: "Console.WriteLine"
    within: handler
  - id: dedup-review
    class: manual
    text: Deduplication must use the message id, not the payload hash.
---

# User sync handler

## Contracts
- [binding:handler] Dependencies \`ILogger\` and \`IEventStore\` are injected.
- [rule:no-console] No direct console logging.
- [rule:dedup-review] Deduplication uses the message id.
`;

/** The ADR log with the requirements' architecture rule (spec AC-6). */
const ADR_LOG = `---
catspec: 1
id: architecture
type: architecture
status: implemented
rules:
  - id: domain-no-infrastructure
    adr: ADR-001
    class: structural
    forbid_import:
      from: "src/Domain/**"
      to: ["Infrastructure.*"]
---

# Architecture Decision Records

## ADR-001: The domain doesn't depend on infrastructure

- **Status:** Accepted
`;

/** The fixture in a temporary folder, as its correct or its broken variant. */
async function microservice(variant: "correct" | "broken" = "correct"): Promise<string> {
  const fixture = await loadFixture("microservice");
  fixtures.push(fixture);
  const broken = join(fixture.dir, "broken");
  if (variant === "broken") await cp(broken, fixture.dir, { recursive: true });
  await rm(broken, { recursive: true });
  await writeFiles(fixture.dir, {
    "docs/spec/user-sync/user-sync-handler.spec.md": USER_SYNC_SPEC,
    "docs/architecture/adr/microservice-adr.md": ADR_LOG,
  });
  return fixture.dir;
}

interface ExpectedDiagnostic {
  code: string;
  spec: string;
  file: string;
  line: number;
  message: string;
}

interface JsonReport {
  diagnostics: {
    code: string;
    spec?: string;
    message: string;
    codeLocation?: { file: string; line: number };
  }[];
}

describe("F4 csharp-language-support", () => {
  it("[AC-F4-1] passes the requirements' C# example and reports a renamed HandleAsync with CS0203 and did-you-mean (spec AC-1 on C#)", async () => {
    const dir = await microservice();
    const pass = await catspec(dir, "check");
    expect(pass.stderr).toBe("");
    expect(pass.code).toBe(0);

    const file = join(dir, HANDLER_DIR, "UserUpdatedHandler.Handle.cs");
    const code = await readFile(file, "utf8");
    await writeFile(file, code.replace("HandleAsync(", "ProcessAsync("));
    const fail = await catspec(dir, "check");
    expect(fail.code).toBe(1);
    expect(fail.stdout).toContain(
      "CS0203 member HandleAsync missing in Identity.Handlers.UserUpdatedHandler",
    );
    expect(fail.stdout).toContain(
      `did you mean ProcessAsync? (${HANDLER_DIR}/UserUpdatedHandler.Handle.cs:8:23)`,
    );
  });

  it('[AC-F4-2] reports CS0603 for "using Infrastructure.Persistence;" in a Domain file under a rule forbidding "using Infrastructure.*" (spec AC-6 on C#)', async () => {
    const dir = await microservice();
    await writeFile(
      join(dir, "src/Domain/User.cs"),
      "using Infrastructure.Persistence;\n\nnamespace Domain;\n\npublic sealed class User { }\n",
    );
    const { code, stdout } = await catspec(dir, "check");
    expect(code).toBe(1);
    expect(stdout).toContain(
      'CS0603 src/Domain/User.cs imports Infrastructure.Persistence; rule "domain-no-infrastructure"',
    );
    expect(stdout).toContain("at src/Domain/User.cs:1:1");
  });

  it("[AC-F4-3] finds HandleAsync in the second file of partial class UserUpdatedHandler through the file glob", async () => {
    const dir = await microservice();
    const parts = [
      `${HANDLER_DIR}/UserUpdatedHandler.cs`,
      `${HANDLER_DIR}/UserUpdatedHandler.Handle.cs`,
    ];
    // The class is split over both files, and only the second one declares HandleAsync.
    expect(await readFile(join(dir, parts[0]!), "utf8")).toContain(
      "public partial class UserUpdatedHandler(",
    );
    expect(await readFile(join(dir, parts[0]!), "utf8")).not.toContain("HandleAsync");
    expect(await readFile(join(dir, parts[1]!), "utf8")).toContain(
      "public async Task HandleAsync(",
    );

    const { code, stdout } = await catspec(dir, "check", "--spec", "user-sync-handler");
    expect(stdout).not.toContain("CS0203");
    expect(stdout).toContain("DONE");
    expect(code).toBe(0);
  });

  it("[AC-csharp-acceptance-1] gives exit 0 on the correct microservice variant and exactly the diagnostics of expected.json on the broken one", async () => {
    const expected = JSON.parse(
      await readFile(join(fixturesDir, "microservice", "expected.json"), "utf8"),
    ) as Record<"correct" | "broken", { exitCode: number; diagnostics: ExpectedDiagnostic[] }>;

    for (const variant of ["correct", "broken"] as const) {
      const dir = await microservice(variant);
      const result = await catspec(dir, "check", "--format", "json");
      expect(result.stderr, variant).toBe("");
      expect(result.code, variant).toBe(expected[variant].exitCode);
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(
        report.diagnostics.map((d) => ({
          code: d.code,
          spec: d.spec,
          file: d.codeLocation?.file,
          line: d.codeLocation?.line,
          message: d.message,
        })),
        variant,
      ).toEqual(expected[variant].diagnostics);
    }
  });
});
