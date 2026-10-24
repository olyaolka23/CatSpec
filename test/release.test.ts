/**
 * Feature F9 `release-0-1`, PBI `release-packaging`: 0.1.0 is published only by the release
 * workflow, after a green acceptance sweep on 3 OSes and the owner's approval, with release notes
 * that list the known limits.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

interface Step {
  run?: string;
  uses?: string;
}
interface Job {
  needs?: string | string[];
  environment?: string;
  strategy?: { matrix?: { os?: string[] } };
  steps: Step[];
}

const PACKAGES = ["core", "lang", "lang-typescript", "lang-csharp", "cli", "mcp", "catspec"];

describe("F9 release-0-1: release (PBI release-packaging)", () => {
  it("[AC-release-packaging-1] publishes 0.1.0 only after a green acceptance sweep and the owner's approval, with release notes listing the known limits", () => {
    const workflow = parse(read(".github/workflows/release.yml")) as {
      on: Record<string, unknown>;
      jobs: Record<string, Job>;
    };
    // Started by hand only.
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);

    // The sweep: every test, the benchmark and every scenario of every feature, on 3 OSes.
    const sweep = workflow.jobs.sweep!;
    expect(sweep.strategy?.matrix?.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    const runs = sweep.steps.map((s) => s.run).filter(Boolean);
    expect(runs).toEqual(
      expect.arrayContaining(["npm test", "npm run bench", "npm run check:acceptance -- --all"]),
    );

    // Publishing waits for the sweep and for the approval of the protected environment.
    const publish = workflow.jobs.publish!;
    expect(publish.needs).toBe("sweep");
    expect(publish.environment).toBe("npm-release");
    expect(publish.steps.map((s) => s.run)).toContain("npx changeset publish");
    // Nothing else in the repository publishes.
    for (const file of ["package.json", ".github/workflows/ci.yml"]) {
      expect(read(file)).not.toMatch(/npm publish|changeset publish/);
    }

    // The release notes: a minor bump of every package (0.0.0 → 0.1.0), with the known limits.
    const notes = read(".changeset/release-0-1.md");
    const [, header, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(
      notes.replace(/\r\n/g, "\n"),
    )!;
    const bumps = parse(header!) as Record<string, string>;
    const names = PACKAGES.map(
      (dir) =>
        JSON.parse(read(`packages/${dir}/package.json`)) as { name: string; version: string },
    );
    expect(bumps).toEqual(Object.fromEntries(names.map((p) => [p.name, "minor"])));
    expect(names.every((p) => p.version === "0.0.0")).toBe(true);
    expect(body).toContain("Known limits:");
    expect(body).toMatch(/Syntax only/);
  });
});
