/**
 * The repository boundary of the MCP server (plan §D14): every path an agent passes is resolved
 * against the repository root, and anything that ends up outside it, directly or through a
 * symbolic link, is refused before a file is read.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { toPosix } from "@catspec/core";

/** A path outside the repository; the tool call fails and nothing is read. */
export class OutsideRepositoryError extends Error {
  constructor(readonly path: string) {
    super(`refused: "${path}" is outside the repository; pass a path inside it`);
    this.name = "OutsideRepositoryError";
  }
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
};

/** The real path of `path`, or of its closest existing ancestor joined with the rest. */
function realPath(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = realpathSync.native(existing);
  return resolve(real, relative(existing, path));
}

/**
 * `path` (relative to `root`, or absolute) as a repository-relative path with forward slashes.
 * Throws `OutsideRepositoryError` for a path outside `root`.
 */
export function repositoryPath(root: string, path: string): string {
  if (path.includes("\0")) throw new OutsideRepositoryError(path);
  const absolute = resolve(root, path);
  if (!inside(root, absolute) || !inside(realPath(root), realPath(absolute))) {
    throw new OutsideRepositoryError(path);
  }
  return toPosix(relative(root, absolute));
}
