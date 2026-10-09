import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

const PACKAGES = [
  ["core", "@catspec/core"],
  ["lang", "@catspec/lang"],
  ["lang-typescript", "@catspec/lang-typescript"],
  ["lang-csharp", "@catspec/lang-csharp"],
  ["cli", "@catspec/cli"],
  ["mcp", "@catspec/mcp"],
  ["catspec", "catspec"],
] as const;

interface PackageJson {
  name: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, { import?: string; types?: string }>;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const rootPackage = readJson<PackageJson>(join(root, "package.json"));

describe("monorepo", () => {
  it("[AC-monorepo-setup-1] root build, lint, typecheck and test scripts cover every package", () => {
    expect(rootPackage.workspaces).toEqual(PACKAGES.map(([dir]) => `packages/${dir}`));
    const scripts = rootPackage.scripts ?? {};
    expect(scripts.build).toBe("npm run build --workspaces");
    expect(scripts.lint).toMatch(/^eslint \. --max-warnings=0/);
    expect(scripts.typecheck).toBe("tsc -p tsconfig.json");
    expect(scripts.test).toBe("vitest run");
    expect(scripts.pretest).toBe("npm run build");

    const tsconfig = readJson<{ include: string[] }>(join(root, "tsconfig.json"));
    expect(tsconfig.include).toEqual(expect.arrayContaining(["packages/*/src", "packages/*/test"]));

    for (const [dir, name] of PACKAGES) {
      const pkg = readJson<PackageJson>(join(root, "packages", dir, "package.json"));
      expect(pkg.name).toBe(name);
      expect(pkg.scripts?.build).toBe("tsup");
      expect(existsSync(join(root, "packages", dir, "test", "index.test.ts"))).toBe(true);
    }
  });

  it("keeps the dependency direction core ← lang ← lang-* ← cli / mcp (ADR-003)", () => {
    const deps = (dir: string): string[] =>
      Object.keys(
        readJson<PackageJson>(join(root, "packages", dir, "package.json")).dependencies ?? {},
      );
    expect(deps("core").filter((d) => d.startsWith("@catspec/"))).toEqual([]);
    expect(deps("lang")).not.toContain("@catspec/cli");
    expect(deps("lang")).not.toContain("@catspec/mcp");
    for (const adapter of ["lang-typescript", "lang-csharp"]) {
      expect(deps(adapter)).toEqual(["@catspec/lang"]);
    }
  });

  it("[AC-F0-1] every package is built by npm test and loads as an ES module", async () => {
    for (const [dir, name] of PACKAGES) {
      const pkgDir = join(root, "packages", dir);
      const entry = readJson<PackageJson>(join(pkgDir, "package.json")).exports?.["."];
      expect(entry?.import, name).toBe("./dist/index.js");
      expect(existsSync(join(pkgDir, "dist", "index.d.ts")), `${name} types`).toBe(true);

      const loaded = (await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href)) as {
        packageName: string;
      };
      expect(loaded.packageName).toBe(name);
    }
  });
});

describe("CI workflow", () => {
  interface Workflow {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      {
        "runs-on": string;
        strategy: { "fail-fast": boolean; matrix: { os: string[]; node: number[] } };
        steps: { run?: string; uses?: string; with?: Record<string, unknown> }[];
      }
    >;
  }

  it("[AC-ci-pipeline-1] runs lint, typecheck, tests and acceptance coverage on 3 OSes × Node 20 and 22", () => {
    const workflow = parse(
      readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
    ) as Workflow;
    expect(Object.keys(workflow.on)).toContain("pull_request");

    const job = workflow.jobs.check!;
    expect(job.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(job.strategy.matrix.node).toEqual([20, 22]);
    expect(job.strategy["fail-fast"]).toBe(false);

    const runs = job.steps.map((s) => s.run).filter(Boolean);
    expect(runs).toEqual([
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run check:acceptance",
    ]);
    const setupNode = job.steps.find((s) => s.uses?.startsWith("actions/setup-node"));
    expect(setupNode?.with?.cache).toBe("npm");
  });
});
