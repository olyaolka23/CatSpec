/**
 * Feature F9 `release-0-1`, PBI `release-packaging` (spec §4 Install, plan §D11.1): the packages as
 * npm publishes them install into a new project without running any install script (no native
 * build step), and `npx catspec init` and `npx catspec check` work there.
 *
 * The packages are built into a staging folder rather than packed from `packages/*\/dist`, which
 * the monorepo test rebuilds while the tests run.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsup";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

interface PackageJson {
  name: string;
  files?: string[];
  dependencies?: Record<string, string>;
}

/** The workspace folders, in dependency order. */
const PACKAGES = ["core", "lang", "lang-typescript", "lang-csharp", "mcp", "cli", "catspec"];

/** npm, or npx with `npx: true`, without a shell where possible (as in the monorepo test). */
function npm(args: string[], cwd: string, npx = false): SpawnSyncReturns<string> {
  const npmCli = process.env.npm_execpath;
  const options = {
    cwd,
    encoding: "utf8" as const,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  };
  if (npmCli && /npm-cli\.c?js$/.test(npmCli)) {
    const script = npx ? join(dirname(npmCli), "npx-cli.js") : npmCli;
    return spawnSync(process.execPath, [script, ...args], options);
  }
  return spawnSync(npx ? "npx" : "npm", args, { ...options, shell: process.platform === "win32" });
}

const expectSuccess = (run: SpawnSyncReturns<string>, what: string): void => {
  expect(run.status, `${what} failed:\n${run.stdout}\n${run.stderr}`).toBe(0);
};

/** Copies a package's manifest and published folders, builds its `dist`, and packs it. */
async function pack(dir: string, staging: string, tarballs: string): Promise<string> {
  const source = join(root, "packages", dir);
  const target = join(staging, dir);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as PackageJson;
  cpSync(join(source, "package.json"), join(target, "package.json"));
  for (const folder of manifest.files ?? []) {
    if (folder !== "dist") cpSync(join(source, folder), join(target, folder), { recursive: true });
  }
  await build({
    config: false,
    entry: ["index.ts", "bin.ts"]
      .map((file) => join(source, "src", file))
      .filter((file) => existsSync(file)),
    outDir: join(target, "dist"),
    format: ["esm"],
    target: "node22",
    platform: "node",
    tsconfig: join(source, "tsconfig.json"),
    external: Object.keys(manifest.dependencies ?? {}),
    silent: true,
  });
  const packed = npm(["pack", "--pack-destination", tarballs, "--json"], target);
  expectSuccess(packed, `npm pack ${manifest.name}`);
  const [result] = JSON.parse(packed.stdout) as [{ filename: string }];
  return join(tarballs, result.filename);
}

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

describe("F9 release-0-1: packaging (PBI release-packaging)", () => {
  it("[AC-F9-1] npx catspec init and npx catspec check succeed in a new git repository without a native build step", async () => {
    const staging = temp("catspec-staging-");
    const tarballs = join(staging, "tarballs");
    mkdirSync(tarballs);
    const files: string[] = [];
    for (const dir of PACKAGES) files.push(await pack(dir, staging, tarballs));

    const project = temp("catspec-clean-");
    expectSuccess(spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8" }), "git init");
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "clean-install", private: true, type: "module" }),
    );
    // --ignore-scripts: nothing may need an install script (no native compilation, spec §4).
    expectSuccess(
      npm(["install", "--ignore-scripts", "--no-package-lock", ...files], project),
      "npm install",
    );
    expect(readdirSync(join(project, "node_modules"))).toContain("catspec");

    const init = npm(["--no-install", "catspec", "init"], project, true);
    expectSuccess(init, "npx catspec init");
    expect(existsSync(join(project, "catspec.yaml"))).toBe(true);

    writeFileSync(
      join(project, "src.ts"),
      "export class Greeter {\n  greet(name: string): string {\n    return name;\n  }\n}\n",
    );
    const check = npm(["--no-install", "catspec", "check"], project, true);
    expectSuccess(check, "npx catspec check");
    expect(check.stdout).toMatch(/0 errors/);
  }, 600_000);
});
