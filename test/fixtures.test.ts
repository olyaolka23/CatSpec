import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturesDir, loadFixture, type LoadedFixture } from "./fixtures.js";

describe("loadFixture", () => {
  const loaded: LoadedFixture[] = [];

  afterEach(async () => {
    await Promise.all(loaded.splice(0).map((f) => f.cleanup()));
  });

  async function load(name: string): Promise<LoadedFixture> {
    const fixture = await loadFixture(name);
    loaded.push(fixture);
    return fixture;
  }

  it("[AC-fixture-conventions-1] gives each test its own copy of a fixture", async () => {
    const original = await readFile(join(fixturesDir, "sample", "src", "greeter.ts"), "utf8");
    const first = await load("sample");
    const second = await load("sample");
    expect(first.dir).not.toBe(second.dir);

    await writeFile(join(first.dir, "src", "greeter.ts"), "// changed by the first test\n");

    expect(await readFile(join(second.dir, "src", "greeter.ts"), "utf8")).toBe(original);
    expect(await readFile(join(fixturesDir, "sample", "src", "greeter.ts"), "utf8")).toBe(original);
  });

  it("copies the files listed in the fixture's expected.json", async () => {
    const fixture = await load("sample");
    const expected = JSON.parse(await readFile(join(fixture.dir, "expected.json"), "utf8")) as {
      files: string[];
    };
    for (const file of expected.files) {
      await expect(readFile(join(fixture.dir, file), "utf8")).resolves.toBeTypeOf("string");
    }
  });

  it("rejects an unknown fixture", async () => {
    await expect(loadFixture("does-not-exist")).rejects.toThrow('unknown fixture "does-not-exist"');
  });
});
