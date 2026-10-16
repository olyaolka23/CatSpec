/**
 * Source providers (plan §D11.3, analysis F-9), PBI `source-providers`: one interface to read the
 * files of a repository from the working tree, the git index or a revision, so every check runs
 * the same way on each. Listings skip `node_modules`, dot-folders, symbolic links and
 * submodules, like `listFiles`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { compareStrings } from "../diagnostics.js";
import { isListedPath, listFiles } from "../util.js";
import type { Git, TreeEntry } from "./git.js";

/** A file of a source: its root-relative POSIX path and, when known, its git blob SHA. */
export interface SourceEntry {
  path: string;
  /** Known for the index and revisions without reading the file, so caches can skip reading. */
  blobSha?: string;
}

export interface SourceProvider {
  readonly kind: "worktree" | "index" | "revision";
  /** Every file, sorted by path. */
  list(): Promise<SourceEntry[]>;
  /** A file's content, or undefined when the source has no such file. */
  read(path: string): Promise<Buffer | undefined>;
}

/** The files on disk under `root`. */
export class WorkingTreeProvider implements SourceProvider {
  readonly kind = "worktree";

  constructor(readonly root: string) {}

  async list(): Promise<SourceEntry[]> {
    return (await listFiles(this.root)).map((path) => ({ path }));
  }

  read(path: string): Promise<Buffer | undefined> {
    return readFile(join(this.root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR") {
        return undefined;
      }
      throw error;
    });
  }
}

/** Files of a git tree listing, read through `cat-file --batch`. */
abstract class GitTreeProvider implements SourceProvider {
  abstract readonly kind: "index" | "revision";
  private listing?: Promise<Map<string, string>>;

  constructor(readonly git: Git) {}

  protected abstract entries(): Promise<TreeEntry[]>;

  async list(): Promise<SourceEntry[]> {
    const files = await this.files();
    return [...files].map(([path, blobSha]) => ({ path, blobSha }));
  }

  async read(path: string): Promise<Buffer | undefined> {
    const sha = (await this.files()).get(path);
    return sha === undefined ? undefined : this.git.readBlob(sha);
  }

  private files(): Promise<Map<string, string>> {
    this.listing ??= this.entries().then((entries) => {
      const regular = entries
        .filter((e) => e.stage === 0 && (e.mode === "100644" || e.mode === "100755"))
        .filter((e) => isListedPath(e.path))
        .sort((a, b) => compareStrings(a.path, b.path));
      return new Map(regular.map((e) => [e.path, e.blobSha]));
    });
    return this.listing;
  }
}

/**
 * The git index: what the next commit will contain. Conflicted files (merge stages 1–3) have no
 * staged content yet and aren't listed.
 */
export class IndexProvider extends GitTreeProvider {
  readonly kind = "index";

  protected entries(): Promise<TreeEntry[]> {
    return this.git.lsFiles();
  }
}

/** The files of a revision, e.g. `HEAD`. */
export class RevisionProvider extends GitTreeProvider {
  readonly kind = "revision";

  constructor(
    git: Git,
    readonly revision: string,
  ) {
    super(git);
  }

  protected entries(): Promise<TreeEntry[]> {
    return this.git.lsTree(this.revision);
  }
}
