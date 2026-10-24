import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ESLint } from "eslint";
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
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: Record<string, { import?: string; types?: string }>;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const rootPackage = readJson<PackageJson>(join(root, "package.json"));

/** Runs an npm script the way a contributor would, without a shell where possible. */
function npm(args: string[]): SpawnSyncReturns<string> {
  const npmCli = process.env.npm_execpath;
  const options = { cwd: root, encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024 };
  return npmCli && /\.c?js$/.test(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], options)
    : spawnSync("npm", args, { ...options, shell: process.platform === "win32" });
}

/** Runs a Node CLI from the root node_modules. */
function node(script: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(root, "node_modules", script), ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const expectSuccess = (run: SpawnSyncReturns<string>, what: string): void => {
  expect(run.status, `${what} failed:\n${run.stdout}\n${run.stderr}`).toBe(0);
};

const toPosix = (path: string): string => path.replace(/\\/g, "/");

describe("monorepo", () => {
  it("[AC-monorepo-setup-1] root build, lint, typecheck and test commands succeed and cover every package", async () => {
    expect(rootPackage.workspaces).toEqual(PACKAGES.map(([dir]) => `packages/${dir}`));
    const sources = PACKAGES.map(([dir]) => `packages/${dir}/src/index.ts`);
    const tests = PACKAGES.map(([dir]) => `packages/${dir}/test/index.test.ts`);

    // build: every package's dist is rewritten.
    const started = Date.now() - 1000;
    expectSuccess(npm(["run", "build"]), "npm run build");
    for (const [dir, name] of PACKAGES) {
      const built = statSync(join(root, "packages", dir, "dist", "index.js")).mtimeMs;
      expect(built, `${name} was not rebuilt`).toBeGreaterThanOrEqual(started);
    }

    // typecheck: succeeds, and the program contains every package's sources and tests.
    expectSuccess(npm(["run", "typecheck"]), "npm run typecheck");
    const typechecked = node("typescript/bin/tsc", ["-p", "tsconfig.json", "--listFilesOnly"]);
    expectSuccess(typechecked, "tsc --listFilesOnly");
    const programFiles = typechecked.stdout.split(/\r?\n/).map((f) => toPosix(relative(root, f)));
    expect(programFiles).toEqual(expect.arrayContaining([...sources, ...tests]));

    // lint: succeeds, and ESLint doesn't ignore any package.
    expectSuccess(npm(["run", "lint"]), "npm run lint");
    const eslint = new ESLint({ cwd: root });
    for (const file of [...sources, ...tests]) {
      expect(await eslint.isPathIgnored(join(root, file)), `${file} is ignored by ESLint`).toBe(
        false,
      );
    }

    // test: this run is `npm test`; check that Vitest collects every package's tests.
    const listed = node("vitest/vitest.mjs", ["list", "--filesOnly"]);
    expectSuccess(listed, "vitest list");
    // Each line starts with the Vitest project's name (vitest.config.ts), e.g. `[unit] `.
    const testFiles = listed.stdout
      .split(/\r?\n/)
      .map((f) => toPosix(f.trim().replace(/^\[[^\]]+\]\s*/, "")));
    expect(testFiles).toEqual(expect.arrayContaining(tests));
  }, 300_000);

  it("keeps the dependency direction core ← lang ← lang-* ← cli, core ← mcp ← cli (ADR-003, ADR-024)", () => {
    // Which workspace packages each package may depend on, in any dependency field.
    const allowed: Record<string, string[]> = {
      core: [],
      lang: ["@catspec/core"],
      "lang-typescript": ["@catspec/core", "@catspec/lang"],
      "lang-csharp": ["@catspec/core", "@catspec/lang"],
      // cli starts the MCP server (`catspec mcp`) and injects the engine into it (ADR-024).
      cli: [
        "@catspec/core",
        "@catspec/lang",
        "@catspec/lang-typescript",
        "@catspec/lang-csharp",
        "@catspec/mcp",
      ],
      mcp: ["@catspec/core"],
      catspec: PACKAGES.map(([, name]) => name).filter((name) => name !== "catspec"),
    };
    const workspaceNames = new Set<string>(PACKAGES.map(([, name]) => name));
    const fields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;

    for (const [dir] of PACKAGES) {
      const pkg = readJson<PackageJson>(join(root, "packages", dir, "package.json"));
      const internal = fields
        .flatMap((field) => Object.keys(pkg[field] ?? {}))
        .filter((dep) => workspaceNames.has(dep));
      for (const dep of internal) {
        expect(allowed[dir], `${pkg.name} must not depend on ${dep}`).toContain(dep);
      }
    }
  });

  it("declares every workspace package a package's sources import, so the build doesn't bundle it", () => {
    const sourcesOf = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? sourcesOf(join(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(dir, entry.name)]
            : [],
      );
    for (const [dir, name] of PACKAGES) {
      const pkg = readJson<PackageJson>(join(root, "packages", dir, "package.json"));
      const declared = new Set(Object.keys(pkg.dependencies ?? {}));
      for (const file of sourcesOf(join(root, "packages", dir, "src"))) {
        const text = readFileSync(file, "utf8");
        for (const [, imported] of text.matchAll(/\bfrom\s+"(@catspec\/[a-z-]+|catspec)"/g)) {
          expect(declared, `${name} imports ${imported} in ${relative(root, file)}`).toContain(
            imported,
          );
        }
      }
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
    on: Record<string, { types?: string[] } | null>;
    jobs: Record<
      string,
      {
        if: string;
        strategy: { "fail-fast": boolean; matrix: { os: string; node: number[] } };
        steps: { run?: string; uses?: string; with?: Record<string, unknown> }[];
      }
    >;
  }

  const workflow = parse(
    readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;
  const job = workflow.jobs.check!;

  /**
   * Evaluates the `matrix.os` expression for a pull request with `labels`. It understands the one
   * shape the workflow uses: `fromJSON(format('<template>', contains(<labels>, '<label>') && '<text>' || '', …))`.
   */
  function osFor(labels: string[]): string[] {
    const expression = job.strategy.matrix.os.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    const call = /^fromJSON\(format\('([^']*)',([\s\S]*)\)\)$/.exec(expression);
    if (!call) throw new Error(`unexpected matrix.os expression: ${expression}`);
    const args = [
      ...call[2]!.matchAll(
        /contains\(github\.event\.pull_request\.labels\.\*\.name, '([^']+)'\) && '([^']*)' \|\| ''/g,
      ),
    ].map(([, label, text]) => (labels.includes(label!) ? text! : ""));
    const json = call[1]!.replace(/\{(\d+)\}/g, (_, i: string) => args[Number(i)] ?? "");
    return JSON.parse(json) as string[];
  }

  it("[AC-ci-pipeline-1] runs on Linux × Node 22 and 24 for every PR, and on macOS or Windows by label", () => {
    expect(workflow.on.pull_request?.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "labeled",
    ]);
    expect(job.strategy.matrix.node).toEqual([22, 24]);
    expect(job.strategy["fail-fast"]).toBe(false);

    expect(osFor([])).toEqual(["ubuntu-latest"]);
    expect(osFor(["bug"])).toEqual(["ubuntu-latest"]);
    expect(osFor(["full-ci-mac"])).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(osFor(["full-ci-win"])).toEqual(["ubuntu-latest", "windows-latest"]);
    expect(osFor(["full-ci-win", "full-ci-mac"])).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
    ]);
    // Only a full-ci-* label starts a new run when a label is added.
    expect(job.if).toContain("startsWith(github.event.label.name, 'full-ci-')");

    const runs = job.steps.map((s) => s.run).filter(Boolean);
    expect(runs).toEqual([
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run bench",
      "node packages/cli/dist/bin.js check",
      "npm run check:acceptance",
    ]);
    const setupNode = job.steps.find((s) => s.uses?.startsWith("actions/setup-node"));
    expect(setupNode?.with?.cache).toBe("npm");
  });
});
