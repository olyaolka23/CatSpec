import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gitBlobSha, type FileFacts, type LanguageAdapter, type SourceFile } from "@catspec/core";
import { afterEach, describe, expect, it } from "vitest";

import { createRepo, type TempRepo } from "../../../test/temp-repo.js";
import {
  DiskFactsCache,
  FactsProvider,
  factsCacheFor,
  MemoryFactsCache,
  SymbolIndex,
} from "../src/index.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});
async function repo(git: boolean): Promise<string> {
  const created = await createRepo({}, { git });
  repos.push(created);
  return created.dir;
}

/** An adapter that counts how often it parses; each file has one class named after the file. */
function countingAdapter(version: string): LanguageAdapter & { parsed: number } {
  const adapter = {
    id: "fake",
    extensions: [".fake"],
    version,
    parsed: 0,
    load: () => Promise.resolve(),
    extract(file: SourceFile): FileFacts {
      adapter.parsed++;
      const name = file.text.trim();
      const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
      return {
        path: file.path,
        blobSha: file.blobSha,
        lang: "fake",
        symbols: [
          {
            id: `${file.path}#${name}`,
            name,
            qualifiedName: name,
            kind: "class",
            range,
            nameRange: range,
            modifiers: [],
            attributes: [],
            bases: [],
            typeParams: [],
            members: [],
            bodyTokens: ["a", "b"],
          },
        ],
        imports: [],
        calls: [{ callee: "f", enclosing: `${file.path}#${name}`, range }],
        parseErrors: [],
      };
    },
    normalizeType: (text: string) => ({ text, name: [text], args: [] }),
    qualify: () => "",
  };
  return adapter;
}

const file = (path: string, text: string): SourceFile => ({
  path,
  text,
  blobSha: gitBlobSha(text),
});

describe("parse cache", () => {
  it("[AC-parse-cache-and-index-1] parses a cached file again when the grammar version changes", async () => {
    const cache = new DiskFactsCache(join(await repo(false), "cache"));
    const v1 = countingAdapter("grammar-1");
    new FactsProvider(cache).facts(v1, file("src/a.fake", "A"));
    new FactsProvider(cache).facts(v1, file("src/a.fake", "A"));
    expect(v1.parsed).toBe(1);

    const v2 = countingAdapter("grammar-2");
    expect(new FactsProvider(cache).facts(v2, file("src/a.fake", "A")).symbols[0]?.name).toBe("A");
    expect(v2.parsed).toBe(1);
  });

  it("[AC-F2-3] serves facts of an unchanged file from the cache without parsing it", async () => {
    const root = await repo(true);
    const adapter = countingAdapter("1");
    const provider = new FactsProvider(factsCacheFor(root));
    const first = provider.facts(adapter, file("src/a.fake", "A"));
    expect(adapter.parsed).toBe(1);
    await provider.flush();

    // A later run: a new provider over the same repository.
    const again = new FactsProvider(factsCacheFor(root)).facts(adapter, file("src/a.fake", "A"));
    expect(adapter.parsed).toBe(1);
    expect(again).toEqual(first);

    new FactsProvider(factsCacheFor(root)).facts(adapter, file("src/a.fake", "B"));
    expect(adapter.parsed).toBe(2);
  });

  it("stores the cache in <git-common-dir>/catspec/cache/<lang>/<blob-sha>.json, and in memory outside git", async () => {
    const root = await repo(true);
    const cache = factsCacheFor(root);
    expect(cache).toBeInstanceOf(DiskFactsCache);
    expect((cache as DiskFactsCache).dir).toBe(join(root, ".git", "catspec", "cache"));
    const provider = new FactsProvider(cache);
    provider.facts(countingAdapter("1"), file("src/a.fake", "A"));
    await provider.flush();
    expect(
      new DiskFactsCache(join(root, ".git", "catspec", "cache")).get("fake", gitBlobSha("A"), "1"),
    ).toBeDefined();

    expect(factsCacheFor(await repo(false))).toBeInstanceOf(MemoryFactsCache);
  });

  it("drops body tokens, and moves ids to the new path for the same content elsewhere", () => {
    const provider = new FactsProvider(new MemoryFactsCache());
    const adapter = countingAdapter("1");
    expect(provider.facts(adapter, file("src/a.fake", "A")).symbols[0]).not.toHaveProperty(
      "bodyTokens",
    );
    const copy = provider.facts(adapter, file("lib/copy.fake", "A"));
    expect(adapter.parsed).toBe(1);
    expect(copy.path).toBe("lib/copy.fake");
    expect(copy.symbols[0]?.id).toBe("lib/copy.fake#A");
    expect(copy.calls[0]?.enclosing).toBe("lib/copy.fake#A");
  });

  it("extracts the same content again under another extension, which may use another grammar", () => {
    const provider = new FactsProvider(new MemoryFactsCache());
    const adapter = countingAdapter("1");
    provider.facts(adapter, file("src/a.ts", "A"));
    expect(provider.facts(adapter, file("src/b.tsx", "A")).path).toBe("src/b.tsx");
    expect(adapter.parsed).toBe(2);
  });

  it("treats an unreadable cache entry as a miss", async () => {
    const dir = join(await repo(false), "cache");
    mkdirSync(join(dir, "fake"), { recursive: true });
    writeFileSync(join(dir, "fake", `${gitBlobSha("A")}.json`), "{not json");
    const adapter = countingAdapter("1");
    new FactsProvider(new DiskFactsCache(dir)).facts(adapter, file("src/a.fake", "A"));
    expect(adapter.parsed).toBe(1);
  });
});

describe("symbol index", () => {
  it("is built on the first lookup only and matches qualified-name suffixes", async () => {
    let loads = 0;
    const adapter = countingAdapter("1");
    const index = new SymbolIndex(() => {
      loads++;
      return Promise.resolve([
        adapter.extract(file("src/a.fake", "AuthService")),
        adapter.extract(file("src/b.fake", "Other")),
      ]);
    });
    expect(loads).toBe(0);
    expect(await index.find("AuthService")).toEqual([
      {
        path: "src/a.fake",
        id: "src/a.fake#AuthService",
        qualifiedName: "AuthService",
        kind: "class",
      },
    ]);
    expect(await index.find("Service")).toEqual([]);
    expect(await index.find("Auth.AuthService")).toEqual([]);
    expect(loads).toBe(1);
  });
});
