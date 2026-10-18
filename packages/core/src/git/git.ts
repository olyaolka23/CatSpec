/**
 * Git access (plan §D11.3, ADR-009), PBI `git-access`: git runs with `execFile` / `spawn` and an
 * argument list, never through a shell, so a file name is never interpreted as a command. Object
 * contents are read through one long-lived `git cat-file --batch` process. Every listing uses
 * `-z`, so names with spaces, quotes or newlines arrive unchanged.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

/** Git isn't installed or isn't on PATH (CS0902). */
export class GitUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("git is required but was not found on PATH", { cause });
    this.name = "GitUnavailableError";
  }
}

/** A git command failed. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0] ?? ""} failed${stderr ? `: ${stderr.trim().split("\n")[0]}` : ""}`);
    this.name = "GitError";
  }
}

/** An entry of the index (`ls-files -s`) or of a tree (`ls-tree -r`). */
export interface TreeEntry {
  /** Octal file mode: `100644`, `100755`, `120000` (symbolic link), `160000` (submodule). */
  mode: string;
  blobSha: string;
  /** Merge stage: 0 normally, 1–3 for a conflicted file. Always 0 for a tree. */
  stage: number;
  /** Path relative to the folder git runs in, with forward slashes. */
  path: string;
}

/** A staged change (`diff --cached -M --name-status`). */
export interface StagedChange {
  /** `A` added, `M` modified, `D` deleted, `R` renamed, `C` copied, `T` type changed, … */
  status: string;
  path: string;
  /** The old path of a rename or copy. */
  from?: string;
}

/** A git object read by `cat-file --batch`. */
interface PendingRead {
  resolve: (content: Buffer | undefined) => void;
  reject: (error: Error) => void;
}

/**
 * A long-lived `git cat-file --batch`: object ids go in on stdin, contents come back in order.
 * Requests are pipelined, so reading many files costs one process.
 */
class CatFileBatch {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: PendingRead[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private failure?: Error;
  private readonly exited: Promise<void>;

  constructor(cwd: string, env: NodeJS.ProcessEnv | undefined) {
    this.child = spawn("git", ["cat-file", "--batch"], {
      cwd,
      ...(env ? { env } : {}),
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    let stderr = "";
    this.child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    this.child.on("error", (error: NodeJS.ErrnoException) =>
      this.fail(error.code === "ENOENT" ? new GitUnavailableError(error) : error),
    );
    this.exited = new Promise((resolveExit) => {
      this.child.on("close", (code) => {
        this.fail(new GitError(["cat-file", "--batch"], code, stderr || "exited"));
        resolveExit();
      });
      // A process that never started has nothing to wait for.
      this.child.on("error", () => resolveExit());
    });
    // A closed pipe is reported through `close`; don't let it throw.
    this.child.stdin.on("error", () => undefined);
  }

  /** The content of a blob, or undefined when the object doesn't exist. */
  read(sha: string): Promise<Buffer | undefined> {
    if (this.failure) return Promise.reject(this.failure);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) {
      return Promise.reject(new Error(`not an object id: ${sha}`));
    }
    return new Promise((resolvePromise, reject) => {
      this.pending.push({ resolve: resolvePromise, reject });
      this.child.stdin.write(`${sha}\n`);
    });
  }

  /** Ends the process and waits for it to exit (on Windows its folder stays locked until then). */
  close(): Promise<void> {
    this.child.stdin.end();
    return this.exited;
  }

  private drain(): void {
    for (;;) {
      const request = this.pending[0];
      if (!request) return;
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const header = this.buffer.subarray(0, newline).toString("utf8");
      const parts = header.split(" ");
      if (parts[1] === "missing" || parts[1] === "ambiguous") {
        this.buffer = this.buffer.subarray(newline + 1);
        this.pending.shift();
        request.resolve(undefined);
        continue;
      }
      const size = Number(parts[2]);
      if (parts.length !== 3 || !Number.isInteger(size)) {
        this.fail(new Error(`unexpected git cat-file output: ${header}`));
        return;
      }
      const end = newline + 1 + size;
      if (this.buffer.length < end + 1) return;
      const content = Buffer.from(this.buffer.subarray(newline + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.pending.shift();
      request.resolve(content);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.splice(0)) request.reject(this.failure);
  }
}

/** Git commands for one folder of a repository. Paths are relative to that folder. */
export class Git {
  private batch?: CatFileBatch;

  /**
   * @param cwd The folder git runs in; listings are relative to it.
   * @param env The environment of the git processes (default: this process's).
   */
  constructor(
    readonly cwd: string,
    readonly env?: NodeJS.ProcessEnv,
  ) {}

  /** Runs git with `args` (no shell) and returns its standard output. */
  run(args: readonly string[], options: { input?: string } = {}): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        "git",
        [...args],
        {
          cwd: this.cwd,
          encoding: "buffer",
          maxBuffer: 256 * 1024 * 1024,
          windowsHide: true,
          ...(this.env ? { env: this.env } : {}),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolvePromise(stdout);
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          reject(
            code === "ENOENT"
              ? new GitUnavailableError(error)
              : new GitError(
                  args,
                  typeof code === "number" ? code : null,
                  stderr.toString("utf8") || error.message,
                ),
          );
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }

  /**
   * The repository's top-level folder and git common dir (shared by every worktree), as paths
   * from `cwd` (so they stay comparable with it where the temp folder is a symbolic link).
   */
  async repository(): Promise<{ topLevel: string; commonDir: string; prefix: string }> {
    const out = (await this.run(["rev-parse", "--show-cdup", "--git-common-dir", "--show-prefix"]))
      .toString("utf8")
      .split("\n");
    return {
      topLevel: resolve(this.cwd, out[0]!),
      commonDir: resolve(this.cwd, out[1]!),
      prefix: out[2] ?? "",
    };
  }

  /** True when `cwd` is inside a git work tree. Throws `GitUnavailableError` without git. */
  async isRepository(): Promise<boolean> {
    try {
      return (await this.run(["rev-parse", "--is-inside-work-tree"])).toString().trim() === "true";
    } catch (error) {
      if (error instanceof GitError) return false;
      throw error;
    }
  }

  /** The index (`ls-files -s -z`): files under `cwd`, relative to it. */
  async lsFiles(): Promise<TreeEntry[]> {
    const out = await this.run(["ls-files", "-s", "-z"]);
    return records(out).map((record) => {
      const tab = record.indexOf("\t");
      const [mode, blobSha, stage] = record.slice(0, tab).split(" ");
      return { mode: mode!, blobSha: blobSha!, stage: Number(stage), path: record.slice(tab + 1) };
    });
  }

  /** The files of a revision (`ls-tree -r -z`): files under `cwd`, relative to it. */
  async lsTree(revision: string): Promise<TreeEntry[]> {
    const out = await this.run(["ls-tree", "-r", "-z", revision, "--"]);
    return records(out).map((record) => {
      const tab = record.indexOf("\t");
      const [mode, , blobSha] = record.slice(0, tab).split(" ");
      return { mode: mode!, blobSha: blobSha!, stage: 0, path: record.slice(tab + 1) };
    });
  }

  /**
   * The staged changes (`diff --cached -M --name-status -z --relative`): changes under `cwd`
   * against HEAD (an empty tree before the first commit), relative to `cwd`.
   */
  async stagedChanges(): Promise<StagedChange[]> {
    return nameStatus(
      await this.run([
        "diff",
        "--cached",
        "-M",
        "--name-status",
        "-z",
        "--relative",
        "--no-ext-diff",
        "--no-color",
      ]),
    );
  }

  /**
   * The changes from `revision` to the index (`cached`) or to the working tree
   * (`diff -M --name-status -z --relative <revision>`), relative to `cwd`. Files git doesn't track
   * yet aren't listed.
   */
  async changesSince(
    revision: string,
    options: { cached?: boolean } = {},
  ): Promise<StagedChange[]> {
    return nameStatus(
      await this.run([
        "diff",
        ...(options.cached ? ["--cached"] : []),
        "-M",
        "--name-status",
        "-z",
        "--relative",
        "--no-ext-diff",
        "--no-color",
        revision,
        "--",
      ]),
    );
  }

  /** The commit id `revision` names, or undefined when it names none (e.g. HEAD before the first commit). */
  async commitId(revision: string): Promise<string | undefined> {
    try {
      const out = await this.run(["rev-parse", "--verify", "-q", `${revision}^{commit}`]);
      return out.toString("utf8").trim() || undefined;
    } catch (error) {
      if (error instanceof GitError) return undefined;
      throw error;
    }
  }

  /** The current branch's short name, or undefined when HEAD is detached. */
  async currentBranch(): Promise<string | undefined> {
    try {
      const out = await this.run(["symbolic-ref", "-q", "--short", "HEAD"]);
      return out.toString("utf8").trim() || undefined;
    } catch (error) {
      if (error instanceof GitError) return undefined;
      throw error;
    }
  }

  /** The content of a blob through the long-lived `cat-file --batch`; undefined if missing. */
  readBlob(sha: string): Promise<Buffer | undefined> {
    this.batch ??= new CatFileBatch(this.cwd, this.env);
    return this.batch.read(sha);
  }

  /**
   * The paths among `paths` whose working-tree content differs from the index, as git sees it
   * (`git diff`): line-ending conversion and clean filters applied, untracked files not listed.
   */
  async unstagedFiles(paths: readonly string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const out = await this.run([
      "--literal-pathspecs",
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--",
      ...paths,
    ]);
    return new Set(
      out
        .toString("utf8")
        .split("\0")
        .filter((p) => p !== ""),
    );
  }

  /** Stages files (`git add`); paths are literal, never pathspec patterns. */
  async add(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(["--literal-pathspecs", "add", "--", ...paths]);
  }

  /** A config value, or undefined when it isn't set. */
  async config(key: string): Promise<string | undefined> {
    try {
      const value = (await this.run(["config", "--get", key])).toString("utf8").trim();
      return value === "" ? undefined : value;
    } catch (error) {
      if (error instanceof GitError) return undefined;
      throw error;
    }
  }

  /** A path inside the git dir (`rev-parse --git-path`), e.g. `hooks`; honours core.hooksPath. */
  async gitPath(path: string): Promise<string> {
    const out = (await this.run(["rev-parse", "--git-path", path])).toString("utf8").trim();
    return resolve(this.cwd, out);
  }

  /** Stops the `cat-file --batch` process and waits for it to exit. */
  async close(): Promise<void> {
    const batch = this.batch;
    delete this.batch;
    await batch?.close();
  }
}

/** Parses `diff --name-status -z` output. */
function nameStatus(out: Buffer): StagedChange[] {
  const fields = records(out);
  const changes: StagedChange[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i++]!;
      changes.push({ status: status[0]!, from, path: fields[i++]! });
    } else {
      changes.push({ status: status[0]!, path: fields[i++]! });
    }
  }
  return changes;
}

/** NUL-separated records, without the trailing empty one. */
function records(out: Buffer): string[] {
  const text = out.toString("utf8");
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}
