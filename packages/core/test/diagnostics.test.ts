import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODES,
  createDiagnostic,
  isRegisteredCode,
  sortDiagnostics,
  type DiagnosticCode,
} from "../src/index.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** Every `CSxxxx` code that a source text mentions and that isn't in the registry. */
export function unregisteredCodes(source: string): string[] {
  const codes = new Set([...source.matchAll(/\bCS\d{4}\b/g)].map((m) => m[0]));
  return [...codes].filter((code) => !isRegisteredCode(code)).sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("diagnostic code registry", () => {
  it("[AC-diagnostics-core-2] fails naming a code that is emitted but not registered", () => {
    // The check itself: a source that emits CS9999 is caught and the code is named.
    const emitting = `createDiagnostic("CS9999", { message: "x" }); createDiagnostic("CS0101", { message: "y" });`;
    expect(unregisteredCodes(emitting)).toEqual(["CS9999"]);
    expect(() => createDiagnostic("CS9999" as DiagnosticCode, { message: "x" })).toThrow(
      /unregistered diagnostic code CS9999/,
    );

    // And every code used in the packages' sources is registered.
    const packagesDir = join(repoRoot, "packages");
    const problems = readdirSync(packagesDir).flatMap((pkg) =>
      sourceFiles(join(packagesDir, pkg, "src")).flatMap((file) =>
        unregisteredCodes(readFileSync(file, "utf8")).map(
          (code) => `${code} in ${relative(repoRoot, file)}`,
        ),
      ),
    );
    expect(problems, `unregistered diagnostic codes: ${problems.join(", ")}`).toEqual([]);
  });

  it("gives every code a severity, a title and docs text", () => {
    for (const [code, info] of Object.entries(CODES)) {
      expect(code).toMatch(/^CS\d{4}$/);
      expect(["error", "warning", "info"]).toContain(info.severity);
      expect(info.title.length, code).toBeGreaterThan(0);
      expect(info.docs.length, code).toBeGreaterThan(40);
    }
  });

  it("uses the registered severity unless one is given", () => {
    expect(createDiagnostic("CS0102", { message: "m" }).severity).toBe("warning");
    expect(createDiagnostic("CS0101", { message: "m" }).severity).toBe("error");
    expect(createDiagnostic("CS0101", { message: "m", severity: "warning" }).severity).toBe(
      "warning",
    );
  });

  it("sorts diagnostics by file, line, column and code", () => {
    const at = (file: string, line: number, column = 1) => ({ file, line, column });
    const sorted = sortDiagnostics([
      createDiagnostic("CS0104", { message: "c", specLocation: at("b.spec.md", 1) }),
      createDiagnostic("CS0102", { message: "b", specLocation: at("a.spec.md", 9) }),
      createDiagnostic("CS0101", { message: "a", specLocation: at("a.spec.md", 2, 5) }),
      createDiagnostic("CS0107", { message: "no location" }),
    ]);
    expect(sorted.map((d) => d.message)).toEqual(["no location", "a", "b", "c"]);
  });
});
