/**
 * Puts the user guide (`docs/spec/catspec-user-guide/*.md`, without the guide's own `spec.md`) in
 * `guide/`, or in the folder given as the first argument, so the published package carries the
 * guide of its version for `catspec guide` and the MCP tool `read_guide`.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageDir, "..", "..", "docs", "spec", "catspec-user-guide");
const target = resolve(argv[2] ?? join(packageDir, "guide"));

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of readdirSync(source)) {
  if (file.endsWith(".md") && file !== "spec.md")
    copyFileSync(join(source, file), join(target, file));
}
