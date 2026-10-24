/**
 * Feature F9 `release-0-1`, PBI `robustness-fuzzing` (spec §4 Robustness): no input file, however
 * broken or huge, crashes CatSpec. Random and truncated TypeScript and C# files go through the
 * facts provider the check uses, with both adapters the CLI injects.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_SOURCE_BYTES,
  gitBlobSha,
  parseErrorDiagnostics,
  type FileFacts,
  type LanguageAdapter,
} from "@catspec/core";
import { FactsProvider, MemoryFactsCache } from "@catspec/lang";
import { CSharpAdapter } from "@catspec/lang-csharp";
import { TypeScriptAdapter } from "@catspec/lang-typescript";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

/** The fixtures' source files of one extension, as seeds to truncate and cut. */
const seeds = (pattern: string): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", `fixtures/**/${pattern}`], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => readFileSync(join(repoRoot, file), "utf8"));

/** Characters that make up most of the languages' syntax, so random text reaches deep rules. */
const SYNTAX = [..."{}()<>[];:,.=?!&|+-*/%\"'`\\@#$ \n\t\r", "class", "interface", "namespace"];
const KEYWORDS = ["public", "static", "async", "export", "import", "function", "partial", "=>"];

/** Random text, random syntax, and seeds that are truncated or have a slice cut out. */
function inputs(seedTexts: string[]): fc.Arbitrary<string> {
  const seed = fc.constantFrom(...seedTexts);
  return fc.oneof(
    fc.string({ unit: "binary", maxLength: 400 }),
    fc.string({ unit: fc.constantFrom(...SYNTAX, ...KEYWORDS), maxLength: 300 }),
    fc.tuple(seed, fc.nat()).map(([text, at]) => text.slice(0, at % (text.length + 1))),
    fc.tuple(seed, fc.nat(), fc.nat({ max: 200 })).map(([text, at, length]) => {
      const start = at % (text.length + 1);
      return text.slice(0, start) + text.slice(start + length);
    }),
  );
}

interface Run {
  files: number;
  failures: string[];
}

/** Extracts the facts of every generated file; anything other than CS0901 is a failure. */
function fuzz(adapter: LanguageAdapter, extension: string, texts: string[], runs: number): Run {
  const provider = new FactsProvider(new MemoryFactsCache());
  const result: Run = { files: 0, failures: [] };
  fc.assert(
    fc.property(inputs(texts), (text) => {
      result.files++;
      const path = `src/fuzz${extension}`;
      let facts: FileFacts;
      try {
        facts = provider.facts(adapter, { path, text, blobSha: gitBlobSha(Buffer.from(text)) });
      } catch (error) {
        result.failures.push(`${extension}: ${String(error)} on ${JSON.stringify(text)}`);
        return;
      }
      const other = parseErrorDiagnostics(facts).filter((d) => d.code !== "CS0901");
      if (other.length > 0) result.failures.push(`${extension}: ${other[0]!.code}`);
    }),
    { numRuns: runs, seed: 20261024 },
  );
  return result;
}

/** An adapter whose parser throws on every file. */
const throwing = (adapter: LanguageAdapter): LanguageAdapter =>
  Object.assign(Object.create(adapter) as LanguageAdapter, {
    extract: () => {
      throw new Error("grammar crashed");
    },
  });

describe("F9 release-0-1: robustness (PBI robustness-fuzzing)", () => {
  const ts = new TypeScriptAdapter();
  const cs = new CSharpAdapter();
  beforeAll(async () => {
    await Promise.all([ts.load(), cs.load()]);
  });

  it("[AC-robustness-fuzzing-1] 10,000 random and truncated TypeScript and C# files never throw; every failure is CS0901", () => {
    const tsSeeds = seeds("*.ts");
    const csSeeds = seeds("*.cs");
    expect(tsSeeds.length).toBeGreaterThan(0);
    expect(csSeeds.length).toBeGreaterThan(0);

    const runs = [
      fuzz(ts, ".ts", tsSeeds, 3500),
      fuzz(ts, ".tsx", tsSeeds, 1500),
      fuzz(cs, ".cs", csSeeds, 5000),
    ];
    expect(runs.reduce((sum, run) => sum + run.files, 0)).toBe(10_000);
    expect(runs.flatMap((run) => run.failures)).toEqual([]);
  }, 300_000);

  it("skips a file larger than 1 MiB with one CS0901 and no facts", () => {
    const line = "export const value = 1;\n";
    const text = line.repeat(Math.ceil(MAX_SOURCE_BYTES / line.length) + 1);
    const provider = new FactsProvider(new MemoryFactsCache());
    for (const [adapter, path] of [
      [ts, "src/huge.ts"],
      [cs, "src/Huge.cs"],
    ] as const) {
      const facts = provider.facts(adapter, { path, text, blobSha: "huge" });
      expect(facts.symbols).toEqual([]);
      expect(facts.skipped).toBe("larger than 1 MiB");
      expect(parseErrorDiagnostics(facts)).toMatchObject([
        {
          code: "CS0901",
          severity: "warning",
          codeLocation: { file: path, line: 1, column: 1 },
          message: "file not parsed: larger than 1 MiB",
        },
      ]);
    }
  });

  it("reports an adapter that throws as CS0901 and doesn't cache its empty facts", () => {
    const cache = new MemoryFactsCache();
    const file = { path: "src/a.ts", text: "export class A {}\n", blobSha: "a" };
    const facts = new FactsProvider(cache).facts(throwing(ts), file);
    expect(facts.skipped).toBe("the typescript adapter failed: grammar crashed");
    expect(parseErrorDiagnostics(facts).map((d) => d.code)).toEqual(["CS0901"]);
    expect(cache.get("typescript", "a", ts.version)).toBeUndefined();
    expect(new FactsProvider(cache).facts(ts, file).symbols.map((s) => s.name)).toEqual(["A"]);
  });
});
