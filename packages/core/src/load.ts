/**
 * Finds and loads every spec of a repository (plan §D3, §D4, §D6.4), PBI `spec-loader`, and runs
 * the repository-level checks of `catspec check --specs-only`: unique ids (CS0103), the
 * feature-folder layout (CS0106), the architecture spec (CS0107) and ADR ids (CS0112).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CatspecConfig } from "./config.js";
import {
  compareStrings,
  createDiagnostic,
  sortDiagnostics,
  type Diagnostic,
} from "./diagnostics.js";
import { DependencyGraph } from "./graph.js";
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
  /** The architecture spec (`type: architecture` at `specs.architecture`), if exactly one exists. */
  architecture?: Spec;
  /** ADR ids of the architecture spec's log. */
  adrIds: string[];
  /** Every diagnostic of `catspec check --specs-only`, sorted. */
  diagnostics: Diagnostic[];
}

/** The feature-folder layout: `docs/spec/<feature>/<file>.spec.md`. */
const FEATURE_FOLDER = /^docs\/spec\/[^/]+\/[^/]+$/;
const SPEC_FILE = /(^|\/)[^/]+\.spec\.md$/;

/**
 * Loads every spec under `root` with `config` and runs the spec checks (the pipeline of
 * `catspec check --specs-only`). Spec errors of `deprecated` specs are lowered to warnings (§D8).
 */
export async function loadSpecModel(root: string, config: CatspecConfig): Promise<SpecModel> {
  const files = await listFiles(root);
  const diagnostics: Diagnostic[] = [];
  const specs = new SpecSet();
  const options = { unenforcedProse: config.enforcement.unenforced_prose };

  const isIncluded = globMatcher(config.specs.include);
  const isArchitecture = globMatcher(config.specs.architecture);
  const architectureFiles = files.filter((f) => isArchitecture(f));
  const specFiles = files.filter((f) => isIncluded(f) && !architectureFiles.includes(f));

  /** The specs a diagnostic is about, when it is about more than the one in its file. */
  const involved = new Map<Diagnostic, Spec[]>();

  const read = async (file: string): Promise<Spec | undefined> => {
    const text = await readFile(join(root, file), "utf8");
    const result = readSpec(text, file, options);
    diagnostics.push(...result.diagnostics);
    return result.spec;
  };

  // The architecture spec: exactly one file at `specs.architecture` (CS0107).
  let architecture: Spec | undefined;
  if (architectureFiles.length === 0) {
    diagnostics.push(
      createDiagnostic("CS0107", {
        message: `no architecture spec: no file matches specs.architecture "${config.specs.architecture}"`,
        suggestions: [
          {
            message: "run `catspec init` to create one, or set specs.architecture in catspec.yaml",
          },
        ],
      }),
    );
  } else if (architectureFiles.length > 1) {
    diagnostics.push(
      createDiagnostic("CS0107", {
        specLocation: { file: architectureFiles[0]!, line: 1, column: 1 },
        message:
          `more than one architecture spec matches specs.architecture "${config.specs.architecture}": ` +
          listOf(architectureFiles),
        actual: architectureFiles,
        suggestions: [
          { message: "keep one ADR log, or narrow specs.architecture in catspec.yaml" },
        ],
      }),
    );
  } else {
    const spec = await read(architectureFiles[0]!);
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

  // Layout (CS0106): machine specs live directly in docs/spec/<feature>/, and the architecture
  // spec at specs.architecture.
  if (config.layout === "feature-folders") {
    for (const file of files) {
      if (!SPEC_FILE.test(file) || FEATURE_FOLDER.test(file) || architectureFiles.includes(file)) {
        continue;
      }
      const name = file.split("/").pop()!;
      const deeper = /^docs\/spec\/([^/]+)\/.+\//.exec(file);
      const target = deeper ? `docs/spec/${deeper[1]}/${name}` : `docs/spec/<feature>/${name}`;
      diagnostics.push(
        createDiagnostic("CS0106", {
          ...(specs.byFile.get(file) ? { spec: specs.byFile.get(file)!.id } : {}),
          specLocation: { file, line: 1, column: 1 },
          message: deeper
            ? `${file} is more than one folder deep in docs/spec/; move it to ${target}`
            : `${file} is outside a feature folder; move it to ${target}`,
          expected: "docs/spec/<feature>/<id>.spec.md",
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

  // ADR ids referenced by rules must exist in the ADR log (CS0112).
  const adrIds = architecture?.body.adrIds ?? [];
  if (architecture) {
    for (const spec of specs.byFile.values()) {
      for (const rule of spec.rules) {
        if (rule.adr === undefined || adrIds.includes(rule.adr)) continue;
        const close = didYouMean(rule.adr, adrIds);
        diagnostics.push(
          createDiagnostic("CS0112", {
            spec: spec.id,
            ruleId: rule.id,
            specLocation: specLocation(spec.source, ["rules", rule.index, "adr"]),
            message: `rule "${rule.id}" enforces ${rule.adr}, which is not in the ADR log ${architecture.file}`,
            expected: adrIds,
            actual: rule.adr,
            ...(close.length > 0
              ? { suggestions: close.map((c) => ({ message: `did you mean ${c}?` })) }
              : {}),
          }),
        );
      }
    }
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
  };
}
