/**
 * Puts the C# grammar WASM file in `grammars/` (ADR-023). Source: the WASM build that ships in the
 * pinned `tree-sitter-c-sharp` package; only that file is copied, so the published package stays
 * small. A file that is already up to date is left alone, so tests that read it while a build runs
 * never see a half-written file.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pid } from "node:process";
import { fileURLToPath } from "node:url";

const GRAMMAR = "tree-sitter-c_sharp.wasm";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = dirname(createRequire(import.meta.url).resolve("tree-sitter-c-sharp/package.json"));
const target = join(packageDir, "grammars");
mkdirSync(target, { recursive: true });

const from = join(source, GRAMMAR);
const to = join(target, GRAMMAR);
if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) {
  const temp = `${to}.${pid}.tmp`;
  copyFileSync(from, temp);
  renameSync(temp, to);
}
