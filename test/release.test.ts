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

    // Publishing waits for the sweep and for the approval of the protected environment. The job
    // only stages the packages: npm publishes each one once the owner approves it with 2FA.
    const publish = workflow.jobs.publish!;
    expect(publish.needs).toBe("sweep");
    expect(publish.environment).toBe("npm-release");
    const staging = publish.steps.map((s) => s.run ?? "").join("\n");
    expect(staging).toContain("npm stage publish");
    expect(staging).not.toMatch(/npm publish|changeset publish/);
    // The release is tagged; `changeset tag` makes annotated tags, which need a committer.
    expect(staging).toMatch(/git config user\.name[\s\S]*npx changeset tag/);
    // Nothing else in the repository publishes or stages.
    for (const file of ["package.json", ".github/workflows/ci.yml"]) {
      expect(read(file)).not.toMatch(/npm publish|npm stage publish|changeset publish/);
    }

    // The release notes: `changeset version` moved them into every package's changelog under
    // 0.1.0, the version of every package, with the known limits.
    for (const dir of PACKAGES) {
      const manifest = JSON.parse(read(`packages/${dir}/package.json`)) as { version: string };
      expect(manifest.version, dir).toBe("0.1.0");
      const changelog = read(`packages/${dir}/CHANGELOG.md`).replace(/\r\n/g, "\n");
      const notes = changelog.split(/^## /m).find((section) => section.startsWith("0.1.0\n"));
      expect(notes, dir).toContain("Known limits:");
      expect(notes, dir).toMatch(/Syntax only/);
    }
  });

  it("ships every package under the repository's license, Apache-2.0, with the LICENSE file", () => {
    const license = read("LICENSE");
    expect(license).toContain("Apache License");
    for (const dir of PACKAGES) {
      const manifest = JSON.parse(read(`packages/${dir}/package.json`)) as { license: string };
      expect(manifest.license, dir).toBe("Apache-2.0");
      // npm packs a package's LICENSE file whatever its `files` say.
      expect(read(`packages/${dir}/LICENSE`), dir).toBe(license);
    }
  });

  it("every package links to the repository, so its npm page leads to the guide and issues", () => {
    for (const dir of PACKAGES) {
      const manifest = JSON.parse(read(`packages/${dir}/package.json`)) as {
        repository: { url: string; directory: string };
        homepage: string;
      };
      expect(manifest.repository.url, dir).toBe("git+https://github.com/olyaolka23/CatSpec.git");
      expect(manifest.repository.directory, dir).toBe(`packages/${dir}`);
      expect(manifest.homepage, dir).toMatch(/^https:\/\/github\.com\/olyaolka23\/CatSpec/);
    }
  });
});
