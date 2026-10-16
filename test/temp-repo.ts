/**
 * Temporary repositories built from inline file contents, for tests that need many small variations
 * of a repository (spec files, configs) rather than one committed fixture (`./fixtures.ts`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  /** Absolute path of the repository. */
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a temporary folder with `files` (path → content). With `git: true` it is also a git
 * repository (`git init`), so commands that look for the git root stop there.
 */
export async function createRepo(
  files: Record<string, string>,
  options: { git?: boolean } = {},
): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), "catspec-repo-"));
  if (options.git) execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFiles(dir, files);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), content, "utf8");
  }
}

/** A minimal valid spec file. `extra` is appended to the frontmatter as YAML lines. */
export function specText(
  id: string,
  options: {
    status?: string;
    type?: string;
    dependsOn?: string[];
    extra?: string;
    body?: string;
  } = {},
): string {
  const deps = options.dependsOn ? `depends_on: [${options.dependsOn.join(", ")}]\n` : "";
  return (
    `---\ncatspec: 1\nid: ${id}\ntype: ${options.type ?? "feature"}\n` +
    `status: ${options.status ?? "draft"}\n${deps}${options.extra ?? ""}---\n\n` +
    (options.body ?? `# ${id}\n`)
  );
}

/** A minimal architecture spec (ADR log) with the given ADR ids. */
export function adrLogText(adrIds: string[] = ["ADR-001"], rules = "rules: []\n"): string {
  return (
    `---\ncatspec: 1\nid: architecture\ntype: architecture\nstatus: draft\n${rules}---\n\n` +
    `# Architecture Decision Records\n\n` +
    adrIds.map((id) => `## ${id}: Decision ${id}\n\n- **Status:** Accepted\n`).join("\n")
  );
}

/** The ADR log at its default path, so a repository passes CS0107. */
export const ADR_LOG = "docs/architecture/adr/test-adr.md";

/** A frontmatter whose aliases expand to millions of nodes ("billion laughs"). */
export const ALIAS_BOMB = [
  "---",
  "id: x1",
  "a: &a [x, x, x, x, x, x, x, x, x, x]",
  "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
  "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
  "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
  "e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]",
  "---",
  "",
].join("\n");

/** A temporary git repository with a user, for tests that stage and commit. */
export interface GitRepo {
  /** Absolute path of the repository. */
  dir: string;
  /** Runs git in the repository and returns its output; throws when git fails. */
  git(...args: string[]): string;
  /** Writes files (path → content) into the working tree. */
  write(files: Record<string, string>): Promise<void>;
  /** `git commit` with the hooks; the exit code and the hook's output. */
  commit(message: string): { code: number; output: string };
}

/**
 * Runs `fn` in a new git repository with `files` written (not staged) and removes it afterwards
 * (PBI `git-access`). The repository has a user, no signing, no line-ending conversion and its own
 * hooks folder, so global git settings don't leak in.
 */
export async function withRepo<T>(
  fn: (repo: GitRepo) => Promise<T>,
  files: Record<string, string> = {},
): Promise<T> {
  const { dir, cleanup } = await createRepo(files, { git: true });
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("config", "user.name", "CatSpec Test");
  git("config", "user.email", "test@catspec.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", ".git/hooks");
  const repo: GitRepo = {
    dir,
    git,
    write: (more) => writeFiles(dir, more),
    commit: (message) => {
      const result = spawnSync("git", ["commit", "-q", "-m", message], {
        cwd: dir,
        encoding: "utf8",
      });
      return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
    },
  };
  try {
    return await fn(repo);
  } finally {
    await cleanup();
  }
}
