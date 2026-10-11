/**
 * Puts the TypeScript and TSX grammar WASM files in `grammars/` (ADR-021). Interim source: the
 * pinned prebuilt `tree-sitter-wasms` package; only these two files are copied, so the published
 * package stays small. Files that are already up to date are left alone, so tests that read them
 * while a build runs never see a half-written file.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pid } from "node:process";
import { fileURLToPath } from "node:url";

const GRAMMARS = ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"];

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(
  dirname(createRequire(import.meta.url).resolve("tree-sitter-wasms/package.json")),
  "out",
);
const target = join(packageDir, "grammars");
mkdirSync(target, { recursive: true });

for (const file of GRAMMARS) {
  const from = join(source, file);
  const to = join(target, file);
  if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
  const temp = `${to}.${pid}.tmp`;
  copyFileSync(from, temp);
  renameSync(temp, to);
}
