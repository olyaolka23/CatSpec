/**
 * The synthetic 10k-file repository of the performance budgets (plan §D11.7, analysis F-16, PBI
 * `performance-budgets`): half TypeScript, half C#, with bound specs in both languages and
 * architecture rules that reach every source file, so a full check parses the whole repository.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SyntheticRepoOptions {
  /** Source files in total; half are TypeScript and half C#. */
  files?: number;
  /** Bound specs in total, split between the languages. */
  specs?: number;
}

export interface SyntheticRepo {
  /** Every file of the repository, path → content. */
  files: Record<string, string>;
  /** The bound source files, in spec order. */
  bound: string[];
}

/** Folder size: 100 files per folder. */
const PER_FOLDER = 100;

const tsPath = (i: number): string => `src/web/m${Math.floor(i / PER_FOLDER)}/service-${i}.ts`;
const csPath = (i: number): string => `src/Server/M${Math.floor(i / PER_FOLDER)}/Handler${i}.cs`;

/** A TypeScript source file; `extra` goes into the body of `run`. */
export const tsSource = (i: number, extra = ""): string =>
  `import { helper } from "../shared/helper";\n\n` +
  `export interface Options${i} {\n  retries: number;\n}\n\n` +
  `export class Service${i} {\n` +
  `  constructor(private readonly options: Options${i}) {}\n\n` +
  `  run(input: string): number {\n    return helper(input) + this.options.retries + ${i};${extra}\n  }\n\n` +
  `  stop(): void {}\n}\n`;

/** A C# source file; `extra` goes into the body of `Handle`. */
export const csSource = (i: number, extra = ""): string =>
  `using System;\nusing System.Threading.Tasks;\n\n` +
  `namespace Server.M${Math.floor(i / PER_FOLDER)};\n\n` +
  `public sealed class Handler${i}\n{\n` +
  `    private readonly int _offset = ${i};\n\n` +
  `    public Task<int> Handle(string message)\n    {\n` +
  `        return Task.FromResult(message.Length + _offset);${extra}\n    }\n\n` +
  `    public void Stop() { }\n}\n`;

const spec = (id: string, binding: string): string =>
  `---\ncatspec: 1\nid: ${id}\ntype: feature\nstatus: implemented\nbindings:\n${binding}---\n\n# ${id}\n`;

const ADR_LOG =
  `---\ncatspec: 1\nid: architecture\ntype: architecture\nstatus: implemented\nrules:\n` +
  `  - id: web-has-no-database\n    adr: ADR-001\n    class: structural\n` +
  `    forbid_import:\n      from: "src/web/**"\n      to: ["pg", "mysql2"]\n` +
  `  - id: server-has-no-sql-client\n    adr: ADR-001\n    class: structural\n` +
  `    forbid_import:\n      from: "src/Server/**"\n      to: ["System.Data.SqlClient"]\n` +
  `---\n\n# Architecture Decision Records\n\n## ADR-001: Layers\n\n- **Status:** Accepted\n`;

/** The files of the synthetic repository. */
export function syntheticRepo(options: SyntheticRepoOptions = {}): SyntheticRepo {
  const total = options.files ?? 10_000;
  const specs = options.specs ?? 40;
  const ts = Math.ceil(total / 2);
  const cs = total - ts;
  const files: Record<string, string> = {
    "docs/architecture/adr/synthetic-adr.md": ADR_LOG,
    "src/web/shared/helper.ts": "export const helper = (s: string): number => s.length;\n",
  };
  for (let i = 0; i < ts; i++) files[tsPath(i)] = tsSource(i);
  for (let i = 0; i < cs; i++) files[csPath(i)] = csSource(i);

  const bound: string[] = [];
  const tsSpecs = Math.ceil(specs / 2);
  for (let k = 0; k < specs; k++) {
    const typescript = k < tsSpecs;
    const count = typescript ? tsSpecs : specs - tsSpecs;
    const n = typescript ? k : k - tsSpecs;
    const i = Math.floor((n * (typescript ? ts : cs)) / count);
    const id = typescript ? `web-service-${i}` : `server-handler-${i}`;
    const binding = typescript
      ? `  - symbol: Service${i}\n    kind: class\n    members:\n` +
        `      - { name: run, params: [string], returns: number }\n      - stop\n`
      : `  - symbol: Server.M${Math.floor(i / PER_FOLDER)}.Handler${i}\n    kind: class\n` +
        `    members:\n      - { name: Handle, params: [string], returns: "Task<int>" }\n      - Stop\n`;
    files[`docs/spec/${id}/${id}.spec.md`] = spec(id, binding);
    bound.push(typescript ? tsPath(i) : csPath(i));
  }
  return { files, bound };
}

/** The changed content of a bound file, for the staged check. */
export function changedSource(path: string): string {
  const i = Number(/(\d+)\.(ts|cs)$/.exec(path)![1]);
  return path.endsWith(".ts") ? tsSource(i, " // changed") : csSource(i, " // changed");
}

/** Writes the repository to `dir` (an empty folder) and commits it. */
export async function writeSyntheticRepo(
  dir: string,
  options: SyntheticRepoOptions = {},
): Promise<SyntheticRepo> {
  const repo = syntheticRepo(options);
  const folders = new Set(Object.keys(repo.files).map((file) => dirname(join(dir, file))));
  await Promise.all([...folders].map((folder) => mkdir(folder, { recursive: true })));
  const entries = Object.entries(repo.files);
  for (let i = 0; i < entries.length; i += 500) {
    await Promise.all(
      entries
        .slice(i, i + 500)
        .map(([file, content]) => writeFile(join(dir, file), content, "utf8")),
    );
  }
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "bench@example.com");
  git("config", "user.name", "CatSpec benchmark");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "synthetic repository");
  return repo;
}
