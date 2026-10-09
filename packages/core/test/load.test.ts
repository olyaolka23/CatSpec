import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ADR_LOG,
  adrLogText,
  createRepo,
  specText,
  type TempRepo,
} from "../../../test/temp-repo.js";
import {
  defaultConfig,
  loadConfig,
  loadSpecModel,
  parseConfig,
  type SpecModel,
} from "../src/index.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

async function load(files: Record<string, string>, config = defaultConfig()): Promise<SpecModel> {
  const repo = await createRepo(files, { git: true });
  repos.push(repo);
  return loadSpecModel(repo.dir, config);
}

const summary = (model: SpecModel) =>
  model.diagnostics.map((d) => [d.code, d.specLocation?.file ?? "", d.specLocation?.line ?? 0]);

describe("spec-loader", () => {
  it("[AC-spec-loader-1] reports CS0103 for a duplicate id with both file paths", async () => {
    const model = await load({
      [ADR_LOG]: adrLogText(),
      "docs/spec/auth/login.spec.md": specText("login"),
      "docs/spec/legacy/login.spec.md": specText("login"),
    });
    const duplicates = model.diagnostics.filter((d) => d.code === "CS0103");
    expect(duplicates.map((d) => d.specLocation!.file)).toEqual([
      "docs/spec/auth/login.spec.md",
      "docs/spec/legacy/login.spec.md",
    ]);
    for (const d of duplicates) {
      expect(d.message).toContain("docs/spec/auth/login.spec.md");
      expect(d.message).toContain("docs/spec/legacy/login.spec.md");
      expect(d.specLocation!.line).toBe(3);
    }
    expect(model.specs.byFile.size).toBe(3);
  });

  it('[AC-spec-loader-2] reports CS0106 for a spec outside a feature folder and suggests "docs/spec/<feature>/"', async () => {
    const model = await load({ [ADR_LOG]: adrLogText(), "docs/login.spec.md": specText("login") });
    expect(summary(model)).toEqual([["CS0106", "docs/login.spec.md", 1]]);
    expect(model.diagnostics[0]!.severity).toBe("warning");
    expect(model.diagnostics[0]!.message).toContain("move it to docs/spec/<feature>/login.spec.md");

    // A spec more than one folder deep, and an architecture spec among the feature specs.
    const deep = await load({
      [ADR_LOG]: adrLogText(),
      "docs/spec/auth/api/login.spec.md": specText("login"),
      "docs/spec/auth/rules.spec.md": specText("auth-rules", { type: "architecture" }),
    });
    expect(deep.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["CS0106", expect.stringContaining("move it to docs/spec/auth/login.spec.md")],
      ["CS0106", expect.stringContaining("is an architecture spec outside specs.architecture")],
    ]);

    // With layout: free nothing is reported.
    const free = await load(
      { [ADR_LOG]: adrLogText(), "docs/login.spec.md": specText("login") },
      parseConfig("layout: free\nspecs:\n  include: ['docs/**/*.spec.md']\n"),
    );
    expect(free.diagnostics).toEqual([]);
    expect(free.specs.get("login")).toBeDefined();
  });

  it("[AC-spec-loader-3] reports CS0112 at a rule that references an unknown ADR", async () => {
    const rules = [
      "rules:",
      "  - id: layers",
      "    adr: ADR-001",
      "    class: manual",
      "    text: Layers.",
      "  - id: no-infra",
      "    adr: ADR-099",
      "    class: manual",
      "    text: No infrastructure in the domain.",
      "",
    ].join("\n");
    const model = await load({ [ADR_LOG]: adrLogText(["ADR-001", "ADR-002"], rules) });
    expect(summary(model)).toEqual([["CS0112", ADR_LOG, 12]]);
    expect(model.diagnostics[0]).toMatchObject({
      spec: "architecture",
      ruleId: "no-infra",
      actual: "ADR-099",
    });
    expect(model.diagnostics[0]!.message).toContain("ADR-099");
    expect(model.adrIds).toEqual(["ADR-001", "ADR-002"]);
  });

  it("reports CS0107 when the architecture spec is missing or ambiguous", async () => {
    const missing = await load({ "docs/spec/a/a.spec.md": specText("aa") });
    expect(summary(missing)).toEqual([["CS0107", "", 0]]);
    expect(missing.diagnostics[0]!.message).toContain("docs/architecture/adr/*-adr.md");

    const ambiguous = await load({
      "docs/architecture/adr/one-adr.md": adrLogText(),
      "docs/architecture/adr/two-adr.md": adrLogText(),
    });
    expect(ambiguous.diagnostics.map((d) => d.code)).toEqual(["CS0107"]);
    expect(ambiguous.diagnostics[0]!.message).toContain(
      "one-adr.md, docs/architecture/adr/two-adr.md",
    );
  });

  it("requires type: architecture for the ADR log", async () => {
    const model = await load({
      [ADR_LOG]: adrLogText().replace("type: architecture", "type: feature"),
    });
    expect(summary(model)).toEqual([["CS0101", ADR_LOG, 4]]);
    expect(model.architecture).toBeUndefined();
  });

  it("indexes specs by id and by file, and lowers spec errors of deprecated specs to warnings", async () => {
    const model = await load({
      [ADR_LOG]: adrLogText(),
      "docs/spec/a/old.spec.md": specText("old", { status: "deprecated", dependsOn: ["gone"] }),
      "docs/spec/a/new.spec.md": specText("new", { status: "ready", dependsOn: ["gone"] }),
      "docs/spec/a/notes.md": "# not a spec\n",
    });
    expect(model.specs.all().map((s) => s.id)).toEqual(["architecture", "new", "old"]);
    expect(model.specs.byFile.get("docs/spec/a/old.spec.md")!.id).toBe("old");
    expect(model.diagnostics.map((d) => [d.code, d.spec, d.severity])).toEqual([
      ["CS0104", "new", "error"],
      ["CS0104", "old", "warning"],
    ]);
  });

  it("loads this repository's own ADR log without errors", async () => {
    const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
    const { config } = await loadConfig(root);
    const model = await loadSpecModel(root, config);
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(model.architecture?.file).toBe("docs/architecture/adr/reactive-ast-adr.md");
    expect(model.adrIds).toContain("ADR-003");
  });
});
