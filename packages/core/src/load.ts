/**
 * Finds and loads every spec of a repository (plan §D3, §D4, §D6.4), PBI `spec-loader`, and runs
 * the repository-level checks of `catspec check --specs-only`: unique ids (CS0103), the
 * feature-folder layout (CS0106), the architecture spec (CS0107), lock files without a spec
 * (CS0108) and ADR ids (CS0112). Specs and lock files are read from a source provider: the
 * working tree, or the git index for `check --staged` (F5).
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { workflowProfile, type CatspecConfig } from "./config.js";
import { featureFolderOf } from "./workflow/schema.js";
import {
  compareStrings,
  createDiagnostic,
  sortDiagnostics,
  type Diagnostic,
} from "./diagnostics.js";
import { WorkingTreeProvider, type SourceProvider } from "./git/providers.js";
import { DependencyGraph } from "./graph.js";
import { hasLockFile, lockPathOf, parseLock, type LockFile } from "./lock.js";
import { splitFrontmatter } from "./frontmatter.js";
import { readSpec, specLocation, type Spec } from "./spec.js";
import { didYouMean, globMatcher, listFiles, listOf } from "./util.js";

/** All specs of a repository, by id and by file. */
export class SpecSet {
  readonly byId = new Map<string, Spec>();
  readonly byFile = new Map<string, Spec>();

  /** Adds a spec; returns the spec that already has its id, if any (the new one isn't indexed by id). */
  add(spec: Spec): Spec | undefined {
    this.byFile.set(spec.file, spec);
    const existing = this.byId.get(spec.id);
    if (!existing) this.byId.set(spec.id, spec);
    return existing;
  }

  get(id: string): Spec | undefined {
    return this.byId.get(id);
  }

  /** Specs with a unique id, sorted by id. */
  all(): Spec[] {
    return [...this.byId.values()].sort((a, b) => compareStrings(a.id, b.id));
  }

  get size(): number {
    return this.byId.size;
  }
}

export interface SpecModel {
  root: string;
  config: CatspecConfig;
  specs: SpecSet;
  graph: DependencyGraph;
  /** The architecture spec (`type: architecture` at `specs.architecture`), if exactly one exists:
   * it is optional (ADR-028). */
  architecture?: Spec;
  /** ADR ids of the architecture spec's log and of the plain ADR files at `specs.architecture`. */
  adrIds: string[];
  /** Every diagnostic of `catspec check --specs-only`, sorted. */
  diagnostics: Diagnostic[];
  /** Valid lock files (plan §D7) by spec id. */
  locks: Map<string, LockFile>;
  /** The text of each lock file read, by path, to write only what changed. */
  lockTexts: Map<string, string>;
  /** Where the specs were read from. */
  source: SourceProvider;
}

const SPEC_FILE = /(^|\/)[^/]+\.spec\.md$/;

/**
 * Loads every spec under `root` with `config` and runs the spec checks (the pipeline of
 * `catspec check --specs-only`). Spec errors of `deprecated` specs are lowered to warnings (§D8).
 */
export async function loadSpecModel(
  root: string,
  config: CatspecConfig,
  source: SourceProvider = new WorkingTreeProvider(root),
): Promise<SpecModel> {
  const files = (await source.list()).map((entry) => entry.path);
  const diagnostics: Diagnostic[] = [];
  const specs = new SpecSet();
  const options = { unenforcedProse: config.enforcement.unenforced_prose };

  const isIncluded = globMatcher(config.specs.include);
  const isArchitecture = architectureMatcher(config.specs.architecture);
  const architectureFiles = files.filter((f) => isArchitecture(f));
  const specFiles = files.filter((f) => isIncluded(f) && !architectureFiles.includes(f));

  /** The specs a diagnostic is about, when it is about more than the one in its file. */
  const involved = new Map<Diagnostic, Spec[]>();

  const read = async (file: string): Promise<Spec | undefined> => {
    const text = (await source.read(file))?.toString("utf8") ?? "";
    const result = readSpec(text, file, options);
    diagnostics.push(...result.diagnostics);
    return result.spec;
  };

  // The architecture spec is optional (ADR-028). The files at `specs.architecture` are the
  // repository's ADRs: at most one of them is CatSpec's architecture spec (CatSpec frontmatter,
  // the repository-wide rules); the others are plain ADRs, read only for their ADR ids (CS0107).
  let architecture: Spec | undefined;
  const architectureTexts = new Map<string, string>();
  for (const file of architectureFiles) {
    architectureTexts.set(file, (await source.read(file))?.toString("utf8") ?? "");
  }
  const rulesFiles = architectureFiles.filter((f) =>
    isArchitectureSpecText(architectureTexts.get(f)!),
  );
  // In the git index (`check --staged`), an architecture spec that exists on disk but isn't
  // staged yet, e.g. right after `catspec init --with-adr`, is a warning: the commit is checked
  // without its rules.
  const unstagedLog =
    rulesFiles.length === 0 && source.kind === "index"
      ? await findUnstagedArchitectureSpec(root, isArchitecture)
      : undefined;
  if (unstagedLog) {
    diagnostics.push(
      createDiagnostic("CS0107", {
        severity: "warning",
        message: `the architecture spec ${unstagedLog} isn't staged, so this commit is checked without its rules`,
        suggestions: [{ message: `stage it: git add ${unstagedLog}` }],
      }),
    );
  } else if (rulesFiles.length > 1) {
    diagnostics.push(
      createDiagnostic("CS0107", {
        specLocation: { file: rulesFiles[0]!, line: 1, column: 1 },
        message:
          `more than one architecture spec matches specs.architecture "${config.specs.architecture}": ` +
          listOf(rulesFiles),
        actual: rulesFiles,
        suggestions: [
          {
            message:
              "keep the repository-wide rules in one file, or narrow specs.architecture in catspec.yaml",
          },
        ],
      }),
    );
  } else if (rulesFiles.length === 1) {
    const spec = await read(rulesFiles[0]!);
    if (spec) {
      if (spec.type === "architecture") {
        architecture = spec;
      } else if (spec.valid) {
        diagnostics.push(
          createDiagnostic("CS0101", {
            spec: spec.id,
            specLocation: specLocation(spec.source, ["type"]),
            message: `the architecture spec must have type "architecture", found "${spec.type}"`,
            expected: "architecture",
            actual: spec.type,
          }),
        );
      }
      addSpec(spec);
    }
  }

  // Read in parallel, index in file order (the first file keeps a duplicated id).
  for (const spec of await Promise.all(specFiles.map(read))) {
    if (spec) addSpec(spec);
  }

  function addSpec(spec: Spec): void {
    const existing = specs.add(spec);
    if (!existing) return;
    for (const [here, other] of [
      [existing, spec],
      [spec, existing],
    ] as const) {
      const duplicate = createDiagnostic("CS0103", {
        spec: here.id,
        specLocation: specLocation(here.source, ["id"]),
        message: `duplicate spec id "${here.id}" in ${here.file} and ${other.file}`,
        actual: [existing.file, spec.file],
      });
      involved.set(duplicate, [existing, spec]);
      diagnostics.push(duplicate);
    }
  }

  // Layout (CS0106): machine specs live directly in a feature folder (`docs/spec/<feature>/`, or
  // the workflow's `feature_dir`), and the architecture spec at specs.architecture.
  if (config.layout === "feature-folders") {
    const profile = workflowProfile(config);
    const generic = profile.featureDir.replaceAll("{feature}", "<feature>");
    for (const file of files) {
      if (!SPEC_FILE.test(file) || architectureFiles.includes(file)) continue;
      const name = file.split("/").pop()!;
      const folder = featureFolderOf(profile.featureDirs, file);
      if (folder && file === `${folder.dir}/${name}`) continue;
      const deeper = folder?.dir;
      const target = deeper ? `${deeper}/${name}` : `${generic}/${name}`;
      const where = deeper
        ? deeper.slice(0, deeper.lastIndexOf("/")) || "."
        : generic.replace(/\/?<feature>.*$/, "") || ".";
      diagnostics.push(
        createDiagnostic("CS0106", {
          ...(specs.byFile.get(file) ? { spec: specs.byFile.get(file)!.id } : {}),
          specLocation: { file, line: 1, column: 1 },
          message: deeper
            ? `${file} is more than one folder deep in ${where}/; move it to ${target}`
            : `${file} is outside a feature folder; move it to ${target}`,
          expected: `${generic}/<id>.spec.md`,
          actual: file,
          suggestions: [{ message: `move it to ${target}, or set layout: free in catspec.yaml` }],
        }),
      );
    }
    for (const spec of specs.byFile.values()) {
      if (spec.type !== "architecture" || spec === architecture) continue;
      diagnostics.push(
        createDiagnostic("CS0106", {
          spec: spec.id,
          specLocation: specLocation(spec.source, ["type"]),
          message:
            `${spec.file} is an architecture spec outside specs.architecture ` +
            `("${config.specs.architecture}"); its rules belong in the ADR log`,
          actual: spec.file,
        }),
      );
    }
  }

  // ADR ids referenced by rules must exist in the ADR log (CS0112): the `## ADR-NNN` headings of
  // the architecture spec, and the ids of the plain ADR files next to it. Without any ADRs there
  // is nothing to check against.
  const adrIds = [...(architecture?.body.adrIds ?? [])];
  for (const file of architectureFiles) {
    if (rulesFiles.includes(file)) continue;
    for (const id of plainAdrIds(file, architectureTexts.get(file)!)) {
      if (!adrIds.some((known) => sameAdrId(known, id))) adrIds.push(id);
    }
  }
  const adrLog = architecture?.file ?? `specs.architecture "${config.specs.architecture}"`;
  if (adrIds.length > 0) {
    for (const spec of specs.byFile.values()) {
      for (const rule of spec.rules) {
        const ruleAdr = rule.adr;
        if (ruleAdr === undefined || adrIds.some((id) => sameAdrId(id, ruleAdr))) continue;
        const close = didYouMean(ruleAdr, adrIds);
        diagnostics.push(
          createDiagnostic("CS0112", {
            spec: spec.id,
            ruleId: rule.id,
            specLocation: specLocation(spec.source, ["rules", rule.index, "adr"]),
            message: `rule "${rule.id}" enforces ${ruleAdr}, which is not in the ADR log ${adrLog}`,
            expected: adrIds,
            actual: ruleAdr,
            ...(close.length > 0
              ? { suggestions: close.map((c) => ({ message: `did you mean ${c}?` })) }
              : {}),
          }),
        );
      }
    }
  }

  // Lock files (CS0108): `<spec-id>.lock.json` next to a spec with that id.
  const locks = new Map<string, LockFile>();
  const lockTexts = new Map<string, string>();
  const listed = new Set(files);
  for (const spec of specs.all()) {
    if (!hasLockFile(spec)) continue;
    const path = lockPathOf(spec);
    if (!listed.has(path)) continue;
    const text = (await source.read(path))?.toString("utf8");
    if (text === undefined) continue;
    lockTexts.set(path, text);
    const lock = parseLock(text);
    if (lock?.spec === spec.id) locks.set(spec.id, lock);
  }
  const lockOwners = new Set(
    [...specs.byFile.values()].filter(hasLockFile).map((spec) => lockPathOf(spec)),
  );
  for (const file of files) {
    if (!file.endsWith(".lock.json") || lockOwners.has(file)) continue;
    if (!isIncluded(file.replace(/\.lock\.json$/, ".spec.md"))) continue;
    const id = posix.basename(file).replace(/\.lock\.json$/, "");
    diagnostics.push(
      createDiagnostic("CS0108", {
        specLocation: { file, line: 1, column: 1 },
        message: `${file} has no spec with id "${id}" in ${posix.dirname(file)}/`,
        expected: `a spec with id "${id}" in ${posix.dirname(file)}/`,
        actual: file,
        suggestions: [
          {
            message:
              "delete the lock file, or move it next to its spec (named <spec-id>.lock.json)",
          },
        ],
      }),
    );
  }

  const graph = new DependencyGraph(specs.all());
  diagnostics.push(...graph.diagnostics);

  for (const d of graph.diagnostics) {
    if (d.code === "CS0105" && Array.isArray(d.actual)) {
      involved.set(
        d,
        (d.actual as string[]).flatMap((id) => specs.get(id) ?? []),
      );
    }
  }

  // Spec errors of deprecated specs are warnings (plan §D8), unless the error also involves a
  // spec that isn't deprecated (a cycle through an implemented spec, a duplicated id).
  const lowered = diagnostics.map((d) => {
    if (d.severity !== "error" || !d.code.startsWith("CS01")) return d;
    const own = (d.specLocation && specs.byFile.get(d.specLocation.file)) ?? undefined;
    const about = involved.get(d) ?? (own ? [own] : []);
    const deprecated = about.length > 0 && about.every((s) => s.status === "deprecated");
    return deprecated ? { ...d, severity: "warning" as const } : d;
  });

  return {
    root,
    config,
    specs,
    graph,
    ...(architecture ? { architecture } : {}),
    adrIds,
    diagnostics: sortDiagnostics(lowered),
    locks,
    lockTexts,
    source,
  };
}

/**
 * Matches the files of `specs.architecture` (ADR-028): a glob or a file path as written, or a
 * folder (no glob characters and no `.md` ending) for every Markdown file in it.
 */
export function architectureMatcher(pattern: string): (path: string) => boolean {
  const clean = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (/[*?[\]{}()!]/.test(clean) || /\.md$/i.test(clean)) return globMatcher(clean);
  return globMatcher(`${clean}/**/*.md`);
}

/**
 * True when a file at `specs.architecture` is meant as CatSpec's architecture spec: its
 * frontmatter has a `catspec:` key or `type: architecture`. Other files (no frontmatter, or the
 * frontmatter of an ADR tool) are plain ADRs. A line match, so broken YAML is still reported.
 */
export function isArchitectureSpecText(text: string): boolean {
  const split = splitFrontmatter(text);
  if ("error" in split) return false;
  return /^(catspec\s*:|type\s*:\s*["']?architecture["']?\s*(#.*)?$)/m.test(split.frontmatter.text);
}

/** The ADR ids of a plain ADR file: its file name (`ADR-007-….md`, `0007-….md`) and its
 * `ADR-NNN` headings. */
export function plainAdrIds(file: string, text: string): string[] {
  const ids: string[] = [];
  const name = /^(?:adr-?)?(\d+)(?=[-_. ])/i.exec(posix.basename(file));
  if (name) ids.push(`ADR-${name[1]}`);
  for (const match of text.matchAll(/^#{1,6}[ \t]+\[?(ADR-\d+)\b/gm)) {
    if (!ids.some((id) => sameAdrId(id, match[1]!))) ids.push(match[1]!);
  }
  return ids;
}

/** ADR ids compare by number: `ADR-7`, `ADR-007` and `ADR-0007` are the same decision. */
export const sameAdrId = (a: string, b: string): boolean =>
  Number(a.slice(4)) === Number(b.slice(4)) && /^ADR-\d+$/.test(a) && /^ADR-\d+$/.test(b);

/** An architecture spec on disk that the git index doesn't have yet. */
async function findUnstagedArchitectureSpec(
  root: string,
  isArchitecture: (path: string) => boolean,
): Promise<string | undefined> {
  for (const file of (await listFiles(root)).filter((f) => isArchitecture(f))) {
    const text = await readFile(join(root, file), "utf8").catch(() => "");
    if (isArchitectureSpecText(text)) return file;
  }
  return undefined;
}
