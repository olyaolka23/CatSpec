import { readFile } from "node:fs/promises";

import { defaultConfig } from "@catspec/core";
import {
  AdapterRegistry,
  FactsProvider,
  MemoryFactsCache,
  repositoryFacts,
  SymbolIndex,
} from "@catspec/lang";
import { afterEach, describe, expect, it } from "vitest";

import { createRepo, type TempRepo } from "../../../test/temp-repo.js";
import { GRAMMAR_SOURCE, TypeScriptAdapter } from "../src/index.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

describe("symbol index over a TypeScript repository", () => {
  it('[AC-parse-cache-and-index-2] finds class AuthService of "src/a/AuthService.ts" by name', async () => {
    const created = await createRepo({
      "src/a/AuthService.ts": "export class AuthService {\n  login(): void {}\n}\n",
      "src/b/other.ts": "export class Other {}\n",
      "docs/AuthService.ts": "export class AuthService {}\n",
    });
    repos.push(created);
    const registry = new AdapterRegistry(defaultConfig().languages).register(
      new TypeScriptAdapter(),
    );
    const provider = new FactsProvider(new MemoryFactsCache());
    const index = new SymbolIndex(() => repositoryFacts(created.dir, registry, provider));

    expect(await index.find("AuthService")).toEqual([
      {
        path: "src/a/AuthService.ts",
        id: "src/a/AuthService.ts#AuthService",
        qualifiedName: "AuthService",
        kind: "class",
      },
    ]);
    expect((await index.find("AuthService.login")).map((hit) => hit.id)).toEqual([
      "src/a/AuthService.ts#AuthService.login",
    ]);
  });

  it("puts the pinned grammar source in the adapter version", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(GRAMMAR_SOURCE).toBe(`tree-sitter-wasms@${pkg.devDependencies["tree-sitter-wasms"]}`);
    expect(new TypeScriptAdapter().version).toContain(GRAMMAR_SOURCE);
  });
});
