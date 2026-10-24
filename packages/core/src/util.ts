/** Small helpers shared by the spec model: text positions, paths and "did you mean". */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import picomatch from "picomatch";

import { compareStrings } from "./diagnostics.js";

/** Maps string offsets to 1-based line and column numbers. Works for `\n` and `\r\n` text. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      this.starts.push(i + 1);
    }
  }

  /** 1-based line and column of `offset` (column counts UTF-16 code units). */
  position(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: clamped - this.starts[low]! + 1 };
  }

  /** Offset of the start of a 1-based line. */
  lineStart(line: number): number {
    return this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))]!;
  }
}

/** Converts a path to forward slashes, for output that is the same on every platform. */
export const toPosix = (path: string): string => (sep === "\\" ? path.replace(/\\/g, "/") : path);

/** `path` relative to `root`, with forward slashes. */
export const relativePosix = (root: string, path: string): string => toPosix(relative(root, path));

/** Joins a list as "a, b, c". */
/** `text` with every regular-expression metacharacter escaped. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const listOf = (items: readonly unknown[]): string => items.map(String).join(", ");

/** Optimal string alignment (Damerau-Levenshtein) distance between two strings. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Up to `max` candidates close to `input` (case-insensitive edit distance at most a third of the
 * input's length, minimum 1), closest first.
 */
export function didYouMean(input: string, candidates: Iterable<string>, max = 3): string[] {
  const needle = input.toLowerCase();
  const limit = Math.max(1, Math.floor(needle.length / 3));
  const scored: { candidate: string; distance: number }[] = [];
  for (const candidate of new Set(candidates)) {
    if (candidate === input) continue;
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance <= limit) scored.push({ candidate, distance });
  }
  return scored
    .sort((x, y) => x.distance - y.distance || compareStrings(x.candidate, y.candidate))
    .slice(0, max)
    .map((s) => s.candidate);
}

/** Converts a name to kebab-case: "My Repo_2" → "my-repo-2". */
export const kebabCase = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Lists every file under `root` as a sorted, root-relative POSIX path. Skips `node_modules`,
 * dot-folders (`.git`, `.github`, …), symbolic links and nested projects (`withoutNestedProjects`).
 */
export async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) return;
          await walk(path);
        } else if (entry.isFile()) {
          files.push(relativePosix(root, path));
        }
      }),
    );
  };
  await walk(root);
  return withoutNestedProjects(files.sort(compareStrings));
}

/**
 * Leaves out the files of nested projects: a folder below the root with its own `catspec.yaml`
 * (an example repository, a vendored project) is checked on its own, not as part of the root.
 */
export const withoutNestedProjects = (paths: readonly string[]): string[] => {
  const nested = paths
    .filter((path) => path.endsWith("/catspec.yaml"))
    .map((path) => path.slice(0, -"catspec.yaml".length));
  return nested.length === 0
    ? [...paths]
    : paths.filter((path) => !nested.some((folder) => path.startsWith(folder)));
};

/**
 * True for a root-relative POSIX path that `listFiles` would list: no `node_modules` and no
 * dot-folder (`.git`, `.github`, …) on the way. For listings that don't come from disk (the git
 * index), so every source sees the same files.
 */
export const isListedPath = (path: string): boolean =>
  path
    .split("/")
    .slice(0, -1)
    .every((segment) => segment !== "node_modules" && !segment.startsWith("."));

/** A matcher for root-relative POSIX paths against globs (dot-files excluded). */
export const globMatcher = (patterns: string | readonly string[]): ((path: string) => boolean) =>
  picomatch(typeof patterns === "string" ? patterns : [...patterns], { dot: false });

/** The git blob SHA-1 of a file's content: the same id `git hash-object` prints. */
export const gitBlobSha = (content: string | Uint8Array): string => {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
