/**
 * The MCP tools (plan §D14.1), PBI `mcp-tools`: what an agent calls to read a spec, check its own
 * code against it, and change the spec only as far as ADR-008 allows.
 *
 * Every tool returns a short text for the model and the same facts as JSON (`structuredContent`).
 * Failing checks are results, not errors: `done: false` with the diagnostics. A tool fails (an
 * error result) only when it can't run: an unknown spec, a path outside the repository, an invalid
 * config or patch.
 *
 * The config and the specs are read again on every call, so edits on disk are picked up; the
 * adapters stay loaded and facts are cached by blob SHA (the warm engine, see `Engine`).
 */
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  applyPatch,
  checkCode,
  classifyPatch,
  countDiagnostics,
  didYouMean,
  globMatcher,
  loadConfig,
  loadSpecModel,
  readSpec,
  readYaml,
  sortDiagnostics,
  SPEC_STATUSES,
  statusGate,
  type CatspecConfig,
  type Codebase,
  type Diagnostic,
  type ItemResult,
  type PatchOp,
  type RenameMap,
  type ResolvedBinding,
  type Spec,
  type SpecModel,
  type SpecStatus,
} from "@catspec/core";

import type { Engine } from "./engine.js";
import { OutsideRepositoryError, repositoryPath } from "./paths.js";

/** What a tool answers: a short text for the model and the same facts as JSON. */
export interface ToolOutput {
  text: string;
  data: Record<string, unknown>;
}

/** A tool call that can't run (unknown spec, bad patch); reported as an error result. */
export class ToolError extends Error {}

/** The last compliance check, served as `catspec://diagnostics`. */
export interface LastCheck {
  at: string;
  specs: string[];
  done: boolean;
  diagnostics: Diagnostic[];
}

export interface WorkspaceOptions {
  /** Absolute path of the repository root. */
  root: string;
  /** The `--config` file, if one was given (else `catspec.yaml` is found from the root). */
  configFile?: string;
  engine: Engine;
}

/** One repository served over MCP: its config and specs (read per call) and the engine. */
export class Workspace {
  readonly root: string;
  readonly engine: Engine;
  private readonly configFile: string | undefined;
  /** The last compliance check of this server. */
  last: LastCheck | undefined;

  constructor(options: WorkspaceOptions) {
    this.root = options.root;
    this.engine = options.engine;
    this.configFile = options.configFile;
  }

  /** The config and specs as they are on disk now. */
  async model(): Promise<SpecModel> {
    const { config } = await loadConfig(this.root, this.configFile);
    return loadSpecModel(this.root, config);
  }

  codebase(config: CatspecConfig, staged = false): Promise<Codebase> {
    return this.engine.loadCodebase(this.root, config, staged ? { staged: true } : {});
  }

  /** A path argument, refused when it is outside the repository. */
  path(path: string): string {
    return repositoryPath(this.root, path);
  }
}

export function findSpec(model: SpecModel, id: string): Spec {
  const spec = model.specs.get(id);
  if (spec) return spec;
  const close = didYouMean(id, model.specs.byId.keys());
  throw new ToolError(
    `no spec with id "${id}"${close.length > 0 ? `; did you mean ${close.map((c) => `"${c}"`).join(", ")}?` : ""}; call list_specs to see them`,
  );
}

const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error");

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A model item without its position in the frontmatter list. */
function withoutIndex<T extends { index: number }>(item: T): Omit<T, "index"> {
  const copy: Partial<T> = { ...item };
  delete copy.index;
  return copy as Omit<T, "index">;
}

function valueText(value: unknown): string {
  if (value === undefined) return "-";
  if (typeof value === "string") return value.split(/\r?\n/).join(" ⏎ ");
  if (Array.isArray(value)) return value.length > 0 ? value.map(valueText).join(", ") : "none";
  return JSON.stringify(value);
}

/** Diagnostics as text: for each, what was expected, what was found, where, and the fix. */
export function diagnosticsText(diagnostics: readonly Diagnostic[]): string {
  const lines: string[] = [];
  for (const d of sortDiagnostics(diagnostics.filter((d) => d.severity !== "info"))) {
    const what = d.item ?? d.spec ?? d.specLocation?.file ?? d.codeLocation?.file ?? "repository";
    lines.push(`${d.severity === "error" ? "✖" : "⚠"} ${what}  ${d.code} ${d.message}`);
    if (d.expected !== undefined || d.actual !== undefined) {
      lines.push(`    expected: ${valueText(d.expected)}`, `    found:    ${valueText(d.actual)}`);
    }
    const where = [d.specLocation, d.codeLocation].flatMap((l) =>
      l ? [`${l.file}:${l.line}:${l.column}`] : [],
    );
    if (where.length > 0) lines.push(`    where:    ${where.join("  ")}`);
    const fixes = (d.suggestions ?? []).map((s) => s.message);
    if (fixes.length > 0) lines.push(`    fix:      ${fixes.join("; ")}`);
  }
  return lines.join("\n");
}

function summaryText(diagnostics: readonly Diagnostic[]): string {
  const counts = countDiagnostics(diagnostics);
  return `${plural(counts.errors, "error")}, ${plural(counts.warnings, "warning")}`;
}

// ---------------------------------------------------------------------------------------------

export async function listSpecs(
  ws: Workspace,
  input: { status?: SpecStatus | undefined; ready_only?: boolean | undefined },
): Promise<ToolOutput> {
  const model = await ws.model();
  const specs = model.specs
    .all()
    .filter((s) => input.status === undefined || s.status === input.status)
    .filter((s) => !input.ready_only || model.graph.isReady(s.id));
  const rows = specs.map((s) => ({
    id: s.id,
    title: s.title,
    type: s.type,
    status: s.status,
    file: s.file,
    depends_on: s.dependsOn,
    deps_satisfied: model.graph.depsSatisfied(s.id),
    ready: model.graph.isReady(s.id),
    tasks: { done: s.body.tasks.filter((t) => t.done).length, total: s.body.tasks.length },
  }));
  const text =
    rows.length === 0
      ? "no specs"
      : rows
          .map(
            (r) =>
              `${r.id} (${r.status}${r.ready ? ", ready to start" : ""})  ${r.title}` +
              (r.tasks.total > 0 ? `  tasks ${r.tasks.done}/${r.tasks.total}` : "") +
              (r.depends_on.length > 0
                ? `  depends on ${r.depends_on.join(", ")}${r.deps_satisfied ? "" : " (not satisfied)"}`
                : ""),
          )
          .join("\n");
  return { text, data: { specs: rows } };
}

/** The compliance of `specs` checked as if implemented; remembered as the last check. */
async function compliance(
  ws: Workspace,
  model: SpecModel,
  codebase: Codebase,
  specs: readonly string[],
) {
  const result = await checkCode(model, codebase, { specs, mode: "full" });
  const done = !hasErrors(result.diagnostics);
  ws.last = {
    at: new Date().toISOString(),
    specs: [...specs],
    done,
    diagnostics: result.diagnostics,
  };
  return { result, done };
}

export async function getSpecContext(ws: Workspace, input: { spec_id: string }) {
  const model = await ws.model();
  const spec = findSpec(model, input.spec_id);
  const codebase = await ws.codebase(model.config);
  const { result, done } = await compliance(ws, model, codebase, [spec.id]);
  const resolved = result.resolved.get(spec.id) ?? new Map<string, ResolvedBinding>();
  const files: Record<string, string[]> = Object.fromEntries(
    [...resolved].map(([id, r]) => [id, r.files]),
  );
  const boundFiles = [...resolved.values()].flatMap((r) => r.files);
  const rulesByClass: Record<string, unknown[]> = {};
  for (const rule of spec.rules) (rulesByClass[rule.class] ??= []).push(withoutIndex(rule));
  const architectureRules = (model.architecture?.rules ?? [])
    .filter((rule) => {
      const paths = "paths" in rule ? rule.paths : undefined;
      if (!paths || paths.length === 0) return true;
      const match = globMatcher(paths);
      return boundFiles.some((f) => match(f));
    })
    .map(withoutIndex);
  const dependencies = spec.dependsOn.map((id) => ({
    id,
    status: model.specs.get(id)?.status ?? "missing",
    satisfied: model.specs.get(id)?.status === "implemented",
  }));
  const data = {
    id: spec.id,
    title: spec.title,
    type: spec.type,
    status: spec.status,
    file: spec.file,
    body: spec.source.body.text,
    contract: { bindings: spec.bindings.map(withoutIndex), rules: rulesByClass },
    waivers: spec.waivers.map(withoutIndex),
    dependencies,
    infrastructure: spec.infrastructure,
    files,
    architecture_rules: architectureRules,
    compliance: {
      done,
      items: result.items,
      diagnostics: result.diagnostics,
    },
  };
  const failing = result.items.filter((i) => i.enforceable && !i.passed);
  const text = [
    `spec ${spec.id} (${spec.status}): ${spec.title}  ${spec.file}`,
    dependencies.length > 0
      ? `depends on: ${dependencies.map((d) => `${d.id} (${d.status})`).join(", ")}`
      : "depends on: nothing",
    `bindings: ${spec.bindings.map((b) => `${b.id} → ${b.symbol}${files[b.id] ? ` (${files[b.id]!.join(", ")})` : " (not found)"}`).join("; ") || "none"}`,
    `rules: ${spec.rules.map((r) => `${r.id} (${r.class})`).join(", ") || "none"}`,
    `architecture rules that apply: ${architectureRules.map((r) => r.id).join(", ") || "none"}`,
    `compliance: ${done ? "DONE" : `NOT DONE (${plural(failing.length, "failing item")}: ${failing.map((i) => i.item).join(", ")})`}`,
    ...(done ? [] : [diagnosticsText(result.diagnostics)]),
    "",
    "The full contract, the Markdown body and the diagnostics are in the structured content.",
  ].join("\n");
  return { text, data } satisfies ToolOutput;
}

/** Specs that bind or scope `file`: by a resolved binding, a binding's file hint, or `scope`. */
async function specsForFile(
  model: SpecModel,
  codebase: Codebase,
  file: string,
): Promise<{ spec: Spec; via: string[] }[]> {
  const specs = model.specs.all().filter((s) => s.valid && s.type !== "architecture");
  const result = await checkCode(model, codebase, { specs: specs.map((s) => s.id), mode: "full" });
  const found: { spec: Spec; via: string[] }[] = [];
  for (const spec of specs) {
    const via = new Set<string>();
    const resolved = result.resolved.get(spec.id);
    for (const binding of spec.bindings) {
      if (resolved?.get(binding.id)?.files.includes(file)) via.add(`binding:${binding.id}`);
      else if (binding.file && globMatcher(binding.file)(file)) via.add(`binding:${binding.id}`);
    }
    if (spec.scope.length > 0 && globMatcher(spec.scope)(file)) via.add("scope");
    if (via.size > 0) found.push({ spec, via: [...via] });
  }
  return found;
}

export async function checkCompliance(
  ws: Workspace,
  input: {
    spec_id?: string | undefined;
    file_path?: string | undefined;
    staged?: boolean | undefined;
  },
): Promise<ToolOutput> {
  const file = input.file_path !== undefined ? ws.path(input.file_path) : undefined;
  const model = await ws.model();
  if (input.spec_id !== undefined) findSpec(model, input.spec_id);
  const codebase = await ws.codebase(model.config, Boolean(input.staged));
  let ids: string[];
  if (input.spec_id !== undefined) ids = [input.spec_id];
  else if (file !== undefined)
    ids = (await specsForFile(model, codebase, file)).map((f) => f.spec.id);
  else {
    // The whole repository, each spec by its status (like `catspec check`).
    const result = await checkCode(model, codebase);
    const done = !hasErrors(result.diagnostics);
    ws.last = {
      at: new Date().toISOString(),
      specs: result.checked.map((s) => s.id),
      done,
      diagnostics: result.diagnostics,
    };
    return complianceOutput(
      result.checked.map((s) => s.id),
      done,
      result.items,
      result.diagnostics,
    );
  }
  if (ids.length === 0) {
    return {
      text: `no spec binds ${file}; nothing to check`,
      data: { done: true, specs: [], items: [], diagnostics: [] },
    };
  }
  const { result, done } = await compliance(ws, model, codebase, ids);
  return complianceOutput(ids, done, result.items, result.diagnostics);
}

function complianceOutput(
  specs: string[],
  done: boolean,
  items: ItemResult[],
  diagnostics: Diagnostic[],
): ToolOutput {
  const enforceable = items.filter((i) => i.enforceable);
  const passed = enforceable.filter((i) => i.passed).length;
  const report = diagnosticsText(diagnostics);
  const text = [
    `${specs.join(", ") || "no specs"}: ${passed} of ${plural(enforceable.length, "item")} pass; ${summaryText(diagnostics)}`,
    ...(report ? [report] : []),
    done
      ? "DONE"
      : "NOT DONE: fix the code and call check_compliance again. Never weaken the contract in the spec; ask the developer instead.",
  ].join("\n");
  return {
    text,
    data: { done, specs, summary: countDiagnostics(diagnostics), items, diagnostics },
  };
}

export async function findSpecsForFile(
  ws: Workspace,
  input: { file_path: string },
): Promise<ToolOutput> {
  const file = ws.path(input.file_path);
  const model = await ws.model();
  const codebase = await ws.codebase(model.config);
  const found = await specsForFile(model, codebase, file);
  const specs = found.map(({ spec, via }) => ({
    id: spec.id,
    title: spec.title,
    status: spec.status,
    file: spec.file,
    via,
  }));
  const text =
    specs.length === 0
      ? `no spec binds or scopes ${file}`
      : specs.map((s) => `${s.id} (${s.status}) via ${s.via.join(", ")}  ${s.file}`).join("\n");
  return { text, data: { file, specs } };
}

export async function checkDependencies(
  ws: Workspace,
  input: { spec_id: string },
): Promise<ToolOutput> {
  const model = await ws.model();
  const spec = findSpec(model, input.spec_id);
  const codebase = await ws.codebase(model.config);
  const dependencies = [];
  for (const id of spec.dependsOn) {
    const dep = model.specs.get(id);
    if (!dep) {
      dependencies.push({ id, exists: false, status: "missing", satisfied: false, failing: [] });
      continue;
    }
    const result = await checkCode(model, codebase, { specs: [id], mode: "full" });
    const failing = result.items.filter((i) => i.enforceable && !i.passed).map((i) => i.item);
    const passing = !hasErrors(result.diagnostics);
    dependencies.push({
      id,
      exists: true,
      status: dep.status,
      satisfied: dep.status === "implemented" && passing,
      passing,
      failing,
    });
  }
  const satisfied = dependencies.every((d) => d.satisfied);
  const text =
    dependencies.length === 0
      ? `${spec.id} has no dependencies`
      : [
          ...dependencies.map(
            (d) =>
              `${d.satisfied ? "✔" : "✖"} ${d.id} (${d.status})` +
              (d.failing.length > 0 ? `: failing ${d.failing.join(", ")}` : ""),
          ),
          satisfied
            ? "every dependency is satisfied"
            : "not every dependency is satisfied (implemented and passing): finish them first or ask the developer",
        ].join("\n");
  return { text, data: { spec: spec.id, satisfied, dependencies } };
}

// ---------------------------------------------------------------------------------------------
// Spec edits (ADR-008)

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** JSON merge patch (RFC 7396) of `patch` onto `current` at `path`, as edit operations. */
function mergeOps(
  path: (string | number)[],
  current: unknown,
  patch: Record<string, unknown>,
  ops: PatchOp[],
): void {
  const existing = isObject(current) ? current : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (key in existing) ops.push({ op: "delete", path: [...path, key] });
    } else if (isObject(value) && isObject(existing[key])) {
      mergeOps([...path, key], existing[key], value, ops);
    } else if (!isDeepStrictEqual(existing[key], value)) {
      ops.push({ op: "set", path: [...path, key], value });
    }
  }
}

/**
 * The edit operations of a bindings patch: an object keyed by binding id, where each value is a
 * JSON merge patch of that binding, `null` removes the binding, and an unknown id adds one.
 */
export function bindingsPatchOps(spec: Spec, patch: Record<string, unknown>): PatchOp[] {
  const raw = readYaml(spec.source.frontmatter.text, ["bindings"]);
  const list = Array.isArray(raw) ? (raw as unknown[]) : undefined;
  const ops: PatchOp[] = [];
  const removed: number[] = [];
  const added: Record<string, unknown>[] = [];
  for (const [id, value] of Object.entries(patch)) {
    const binding = spec.bindings.find((b) => b.id === id);
    if (value === null) {
      if (!binding) throw new ToolError(`${spec.id} has no binding "${id}" to remove`);
      removed.push(binding.index);
    } else if (!isObject(value)) {
      throw new ToolError(`the patch of binding "${id}" must be an object, or null to remove it`);
    } else if (!binding) {
      added.push({ id, ...value });
    } else {
      mergeOps(["bindings", binding.index], list?.[binding.index], value, ops);
    }
  }
  if (added.length > 0) {
    if (list === undefined) ops.push({ op: "set", path: ["bindings"], value: added });
    else
      added.forEach((b, i) =>
        ops.push({ op: "set", path: ["bindings", list.length + i], value: b }),
      );
  }
  // Removals last and from the end, so the other indexes still point at the same bindings.
  for (const index of removed.sort((a, b) => b - a)) {
    ops.push({ op: "delete", path: ["bindings", index] });
  }
  return ops;
}

export async function updateSpecBindings(
  ws: Workspace,
  input: { spec_id: string; patch: Record<string, unknown>; dry_run?: boolean | undefined },
): Promise<ToolOutput> {
  const dryRun = input.dry_run ?? true;
  const model = await ws.model();
  const spec = findSpec(model, input.spec_id);
  if (spec.type === "architecture") throw new ToolError(`${spec.id} has no bindings`);
  const ops = bindingsPatchOps(spec, input.patch);
  if (ops.length === 0) {
    return {
      text: `the patch changes nothing in ${spec.file}`,
      data: {
        spec: spec.id,
        file: spec.file,
        ops,
        class: "location",
        applied: false,
        proposal: false,
        diff: "",
      },
    };
  }
  const editClass = classifyPatch(ops, spec.source);
  const after = applyPatch(spec.source, ops);
  const check = readSpec(after, spec.file, {
    unenforcedProse: model.config.enforcement.unenforced_prose,
  });
  const invalid = check.diagnostics.filter((d) => d.severity === "error");
  if (invalid.length > 0) {
    throw new ToolError(
      `the patch would make ${spec.file} invalid; nothing was written:\n${diagnosticsText(invalid)}`,
    );
  }
  const diff = ws.engine.formatDiff(spec.file, spec.source.text, after);
  const allowed =
    editClass === "location"
      ? model.config.mcp.allow_location_edits
      : model.config.mcp.allow_contract_edits;
  const proposal = !allowed;
  const applied = allowed && !dryRun;
  if (applied) await writeFile(join(ws.root, spec.file), after, "utf8");
  const reason =
    editClass === "contract"
      ? "it changes the contract (mcp.allow_contract_edits is false): show this diff to the developer and let them decide; never weaken a contract to make a check pass"
      : "location edits are turned off (mcp.allow_location_edits is false): show this diff to the developer";
  const outcome = applied
    ? `applied this ${editClass} edit to ${spec.file}`
    : proposal
      ? `proposal only, ${spec.file} is unchanged: ${reason}`
      : `dry run, ${spec.file} is unchanged; call again with dry_run false to apply this ${editClass} edit`;
  return {
    text: `${outcome}\n${diff}`,
    data: { spec: spec.id, file: spec.file, ops, class: editClass, applied, proposal, diff },
  };
}

export async function setSpecStatus(
  ws: Workspace,
  input: {
    spec_id: string;
    status: SpecStatus;
    links?:
      | {
          pr?: string | number | undefined;
          issue?: string | number | undefined;
          commit?: string | undefined;
        }
      | undefined;
  },
): Promise<ToolOutput> {
  if (!SPEC_STATUSES.includes(input.status))
    throw new ToolError(`unknown status "${input.status}"`);
  const model = await ws.model();
  const spec = findSpec(model, input.spec_id);
  if (!spec.valid) {
    throw new ToolError(`${spec.file} has errors; fix them first (catspec check --specs-only)`);
  }
  const links = Object.entries(input.links ?? {}).filter(([, v]) => v !== undefined);
  if (spec.status === input.status && links.length === 0) {
    return {
      text: `${spec.id} is already ${spec.status}`,
      data: {
        spec: spec.id,
        from: spec.status,
        to: input.status,
        changed: false,
        refused: false,
        diagnostics: [],
      },
    };
  }
  const codebase = await ws.codebase(model.config);
  const gate =
    spec.status === input.status
      ? { allowed: true, diagnostics: [] }
      : await statusGate(model, codebase, spec, input.status);
  if (!gate.allowed) {
    return {
      text: `refused: ${spec.id} stays ${spec.status}\n${diagnosticsText(gate.diagnostics)}\nFix what fails (check_compliance shows it), then try again.`,
      data: {
        spec: spec.id,
        from: spec.status,
        to: input.status,
        changed: false,
        refused: true,
        diagnostics: gate.diagnostics,
      },
    };
  }
  const ops: PatchOp[] = [
    ...(spec.status === input.status
      ? []
      : [{ op: "set" as const, path: ["status"], value: input.status }]),
    ...links.map(([key, value]) => ({ op: "set" as const, path: ["links", key], value })),
  ];
  await writeFile(join(ws.root, spec.file), applyPatch(spec.source, ops), "utf8");
  return {
    text:
      spec.status === input.status
        ? `${spec.id}: links updated`
        : `${spec.id}: ${spec.status} → ${input.status}`,
    data: {
      spec: spec.id,
      from: spec.status,
      to: input.status,
      changed: true,
      refused: false,
      diagnostics: gate.diagnostics,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Refactor and sync (plan §D11.8)

export async function startRefactor(
  ws: Workspace,
  input: { scope?: string[] | undefined; reason?: string | undefined },
): Promise<ToolOutput> {
  const model = await ws.model();
  // A scope glob names files of the repository: no absolute paths, no way out of it.
  for (const glob of input.scope ?? []) {
    if (isAbsolute(glob) || glob.split(/[\\/]/).includes("..")) {
      throw new OutsideRepositoryError(glob);
    }
  }
  const started = await ws.engine.startRefactor(ws.root, model.config, {
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  return {
    text:
      `refactor started on ${started.branch ?? "a detached HEAD"} from ${started.revision.slice(0, 12)}: ` +
      `${plural(started.bindings, "binding")} of ${plural(started.specs, "spec")} in ${started.scope.join(", ")}.\n` +
      "Rename and move the code, then call sync_specs (a dry run first, then dry_run false) to fix the specs.",
    data: { ...started },
  };
}

export async function syncSpecs(
  ws: Workspace,
  input: {
    map?: { [K in keyof RenameMap]?: RenameMap[K] | undefined } | undefined;
    dry_run?: boolean | undefined;
    partial?: boolean | undefined;
  },
): Promise<ToolOutput> {
  const dryRun = input.dry_run ?? true;
  const model = await ws.model();
  if (!dryRun && !model.config.mcp.allow_location_edits) {
    throw new ToolError(
      "location edits are turned off (mcp.allow_location_edits is false); call sync_specs with dry_run true and show the result to the developer",
    );
  }
  const outcome = await ws.engine.syncSpecs(ws.root, model.config, {
    ...(input.map
      ? {
          map: Object.fromEntries(Object.entries(input.map).filter(([, v]) => v !== undefined)),
        }
      : {}),
    apply: !dryRun,
    ...(input.partial ? { partial: true } : {}),
  });
  return {
    text: outcome.text.trimEnd(),
    data: { ...outcome.report, dry_run: dryRun, done: outcome.problems === 0 },
  };
}
