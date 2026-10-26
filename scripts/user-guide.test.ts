/**
 * Feature F9 `release-0-1`, PBI `user-guide`: the user guide matches the CLI. The generated pages
 * are up to date, and no page names a diagnostic code or a command that doesn't exist.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CODES } from "@catspec/core";
import { beforeAll, describe, expect, it } from "vitest";

import {
  COMMANDS_PAGE,
  commandPaths,
  commandsIn,
  commandsPage,
  DIAGNOSTICS_PAGE,
  diagnosticsPage,
  GUIDE_DIR,
} from "./user-guide.js";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const headings = (text: string, prefix: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());

/** The guide's pages and the README: the documents users read. */
const documents = (): [string, string][] => [
  ...readdirSync(join(root, GUIDE_DIR))
    .filter((file) => file.endsWith(".md"))
    .map((file): [string, string] => [`${GUIDE_DIR}/${file}`, read(`${GUIDE_DIR}/${file}`)]),
  ["README.md", read("README.md")],
];

describe("F9 release-0-1: user guide (PBI user-guide)", () => {
  let paths: string[][] = [];
  beforeAll(async () => {
    paths = await commandPaths();
  });

  it("[AC-user-guide-1] documents every diagnostic code and every command, and nothing that doesn't exist", async () => {
    // The generated pages are what the generator writes now (`npm run guide`).
    expect(read(DIAGNOSTICS_PAGE), "run npm run guide").toBe(diagnosticsPage());
    expect(read(COMMANDS_PAGE), "run npm run guide").toBe(await commandsPage());

    // Every code of the registry, and only those, has its section.
    expect(headings(read(DIAGNOSTICS_PAGE), "## ").sort()).toEqual(Object.keys(CODES).sort());
    // Every command of `catspec --help`, and only those, has its section.
    expect(headings(read(COMMANDS_PAGE), "## catspec").filter(Boolean).sort()).toEqual(
      paths.map((path) => path.join(" ")).sort(),
    );

    // No page names a code or a command that doesn't exist.
    const commands = new Set(paths.map((path) => path[0]!));
    const unknown: string[] = [];
    for (const [file, text] of documents()) {
      for (const [code] of text.matchAll(/\bCS\d{4}\b/g)) {
        if (!(code in CODES)) unknown.push(`${file}: ${code}`);
      }
      // A command as written in code: `catspec x`, npx catspec x, or a code line starting with it.
      for (const match of text.matchAll(/(?:`|npx |^[$\s]*)catspec ([a-z][a-z-]*)/gm)) {
        if (!commands.has(match[1]!)) unknown.push(`${file}: catspec ${match[1]!}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("finds the commands and subcommands in the help", () => {
    expect(paths).toContainEqual(["check"]);
    expect(paths).toContainEqual(["stage", "start"]);
    expect(paths).toContainEqual(["workflow", "doctor"]);
    expect(paths).not.toContainEqual(["help"]);
    expect(
      commandsIn("Usage: x\n\nCommands:\n  a [options]  does a\n               more\n  b  b\n\n"),
    ).toEqual(["a", "b"]);
  });
});
