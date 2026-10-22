/**
 * Workflow profiles at work (plan §D17.1, §D17.4, §D17.5), PBIs `stage-resolution`, `gate-runner`
 * and `workflow-cli`: which features exist, where each feature and work item is in the workflow,
 * the gates, and `stage start|finish`.
 *
 * The current stage is derived, never stored (ADR-004): it is the first stage whose finish gates
 * don't pass yet or whose status its specs haven't reached. Deriving never runs `command:` gates.
 * CatSpec never performs a stage itself; it describes it, checks it and sets the status.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkCode, statusGate, testCommandArgs, type CheckResult } from "../check.js";
import type { Codebase } from "../codebase.js";
import { findGitCommonDir } from "../config.js";
import {
  compareStrings,
  createDiagnostic,
  sortDiagnostics,
  type Diagnostic,
} from "../diagnostics.js";
import type { SpecModel } from "../load.js";
import { applyPatch } from "../spec-editor.js";
import type { SpecStatus } from "../spec-schema.js";
import type { Spec } from "../spec.js";
import { didYouMean, escapeRegExp, globMatcher, listOf } from "../util.js";
import {
  driverText,
  gateName,
  type Driver,
  type Gate,
  type Stage,
  type Transition,
  type WorkflowProfile,
} from "./schema.js";

/** A workflow command that can't run: an unknown stage or target (a usage error). */
export class WorkflowError extends Error {}

export interface Feature {
  name: string;
  /** The feature folder, relative to the repository root. */
  dir: string;
  /** Its machine specs (valid, not the architecture spec), sorted by id. */
  specs: Spec[];
}

/** What a stage command is run for: a feature, or one spec (with its feature, if it has one). */
export interface Target {
  name: string;
  feature?: Feature;
  spec?: Spec;
}

export type Phase = "start" | "finish";

export interface GateResult {
  gate: string;
  passed: boolean;
  /** A `command:` gate that wasn't run (`allow_commands` false): CS0706, doesn't block. */
  skipped?: boolean;
  /** Why it failed or was skipped, or what it checked. */
  detail: string;
  /** The diagnostics behind a failure (the underlying check). */
  diagnostics: Diagnostic[];
}

/** How a command gate runs; replaced in tests. */
export type CommandRunner = (
  root: string,
  args: string[],
) => Promise<{ exitCode: number; output: string }>;

export interface WorkflowOptions {
  now?: Date;
  runCommand?: CommandRunner;
}

const STATUS_RANK: Record<SpecStatus, number> = {
  draft: 0,
  ready: 1,
  "in-progress": 2,
  implemented: 3,
  deprecated: 4,
};

/** True when `status` is `target` or a later status. */
export const reached = (status: SpecStatus, target: SpecStatus): boolean =>
  STATUS_RANK[status] >= STATUS_RANK[target];

/** The status a stage sets: at finish, else at start. */
export const stageStatus = (stage: Stage): SpecStatus | undefined =>
  stage.finish.status ?? stage.start.status;

/**
 * A repository seen through its workflow profile: features, targets, gates and stage positions.
 * Check results are computed once per set of specs.
 */
export class Workflow {
  readonly features: Feature[];
  private readonly checks = new Map<string, Promise<CheckResult>>();
  private readonly featureRegex: RegExp;

  constructor(
    readonly model: SpecModel,
    readonly codebase: Codebase,
    readonly profile: WorkflowProfile,
    /** Every file of the repository (root-relative POSIX paths). */
    readonly files: readonly string[],
    readonly options: WorkflowOptions = {},
  ) {
    const pattern = escapeRegExp(profile.featureDir).replaceAll(
      escapeRegExp("{feature}"),
      "([^/]+)",
    );
    this.featureRegex = new RegExp(`^(${pattern})/`);
    const byName = new Map<string, Feature>();
    for (const file of files) {
      const match = this.featureRegex.exec(file);
      if (!match) continue;
      const name = match[2]!;
      if (profile.notFeatures.includes(name) || byName.has(name)) continue;
      byName.set(name, { name, dir: match[1]!, specs: [] });
    }
    for (const spec of this.specs()) {
      const feature = this.featureNameOf(spec);
      if (feature !== undefined) byName.get(feature)?.specs.push(spec);
    }
    this.features = [...byName.values()].sort((a, b) => compareStrings(a.name, b.name));
  }

  /** The work items: valid specs other than the architecture spec, sorted by id. */
  specs(): Spec[] {
    return this.model.specs.all().filter((s) => s.valid && s.type !== "architecture");
  }

  feature(name: string): Feature | undefined {
    return this.features.find((f) => f.name === name);
  }

  private featureNameOf(spec: Spec): string | undefined {
    const name = this.featureRegex.exec(spec.file)?.[2];
    return name !== undefined && !this.profile.notFeatures.includes(name) ? name : undefined;
  }

  /** The feature a spec belongs to: the feature folder it is in. */
  featureOf(spec: Spec): Feature | undefined {
    const name = this.featureNameOf(spec);
    return name === undefined ? undefined : this.feature(name);
  }

  stage(id: string): Stage {
    const stage = this.profile.stages.find((s) => s.id === id);
    if (stage) return stage;
    const ids = this.profile.stages.map((s) => s.id);
    const close = didYouMean(id, ids);
    throw new WorkflowError(
      `no stage "${id}" in the workflow (${listOf(ids)})` +
        (close.length > 0 ? `; did you mean "${close[0]}"?` : ""),
    );
  }

  /** A feature name or a spec id; a feature wins when a name is both. */
  target(name: string): Target {
    const feature = this.feature(name);
    if (feature) return { name, feature };
    const spec = this.model.specs.get(name);
    if (spec && spec.type !== "architecture") {
      const owner = this.featureOf(spec);
      return { name, spec, ...(owner ? { feature: owner } : {}) };
    }
    const close = didYouMean(name, [
      ...this.features.map((f) => f.name),
      ...this.model.specs.byId.keys(),
    ]);
    throw new WorkflowError(
      `"${name}" is neither a feature (a folder ${this.profile.featureDir}) nor a spec id` +
        (close.length > 0 ? `; did you mean ${close.map((c) => `"${c}"`).join(", ")}?` : ""),
    );
  }

  /** The specs a stage runs on for a target. */
  scope(stage: Stage, target: Target): { feature?: Feature; specs: Spec[] } {
    if (stage.per === "spec") {
      const specs = target.spec ? [target.spec] : (target.feature?.specs ?? []);
      return {
        ...(target.feature ? { feature: target.feature } : {}),
        specs: specs.filter((s) => s.status !== "deprecated"),
      };
    }
    if (!target.feature) {
      throw new WorkflowError(
        `stage "${stage.id}" runs per feature, and spec "${target.name}" isn't in a feature folder (${this.profile.featureDir})`,
      );
    }
    return {
      feature: target.feature,
      specs: target.feature.specs.filter((s) => s.status !== "deprecated"),
    };
  }

  /** The check of `ids` as if implemented, computed once. */
  check(ids: readonly string[]): Promise<CheckResult> {
    const key = [...ids].sort(compareStrings).join("\0");
    let result = this.checks.get(key);
    if (!result) {
      result = checkCode(this.model, this.codebase, {
        specs: ids,
        mode: "full",
        ...(this.options.now ? { now: this.options.now } : {}),
      });
      this.checks.set(key, result);
    }
    return result;
  }

  /** Path templates with the placeholders filled in; `{spec}` repeats for every spec. */
  expand(template: string, feature: Feature | undefined, specs: readonly Spec[]): string[] {
    const base = template
      .replaceAll("{feature_dir}", feature?.dir ?? "")
      .replaceAll("{feature}", feature?.name ?? "");
    return base.includes("{spec}") ? specs.map((s) => base.replaceAll("{spec}", s.id)) : [base];
  }

  /** The files a template names that exist: a plain path, or every match of a glob. */
  existing(path: string): string[] {
    if (!/[*?[\]{}]/.test(path)) return this.files.includes(path) ? [path] : [];
    const matches = globMatcher(path);
    return this.files.filter((f) => matches(f));
  }

  // Gates -----------------------------------------------------------------------------------

  /**
   * Runs one gate for a stage over `specs` (of `feature`). `commands`: run `command:` gates
   * (with `allow_commands`), else report them skipped.
   */
  async gate(
    gate: Gate,
    stage: Stage,
    feature: Feature | undefined,
    specs: readonly Spec[],
    commands: boolean,
  ): Promise<GateResult> {
    const ids = specs.map((s) => s.id);
    const name = gateName(gate);
    const result = (passed: boolean, detail: string, diagnostics: Diagnostic[] = []) => ({
      gate: name,
      passed,
      detail,
      diagnostics,
    });
    if (typeof gate !== "string") return this.commandGate(gate.command, feature, specs, commands);

    switch (gate) {
      case "specs_valid": {
        const inFeature = (file: string | undefined) =>
          feature !== undefined && file !== undefined && file.startsWith(`${feature.dir}/`);
        const errors = this.model.diagnostics.filter(
          (d) =>
            d.severity === "error" &&
            ((d.spec !== undefined && ids.includes(d.spec)) || inFeature(d.specLocation?.file)),
        );
        return errors.length === 0
          ? result(true, `${ids.length} spec(s) valid`)
          : result(
              false,
              `${errors.length} spec error(s); run \`catspec check --specs-only\``,
              errors,
            );
      }
      case "artifacts": {
        const missing: string[] = [];
        for (const template of stage.produces) {
          for (const path of this.expand(template, feature, specs)) {
            const found = [];
            for (const file of this.existing(path)) {
              const content = await this.model.source.read(file);
              if (content && content.toString("utf8").trim().length > 0) found.push(file);
            }
            if (found.length === 0) missing.push(path);
          }
        }
        return missing.length === 0
          ? result(true, stage.produces.length > 0 ? "every artifact exists" : "nothing to produce")
          : result(false, `missing or empty: ${listOf(missing)}`);
      }
      case "contracts_declared": {
        if (specs.length === 0) return result(false, "no machine spec (*.spec.md) yet");
        const empty = specs.filter(
          (s) =>
            !s.aggregate && s.bindings.length === 0 && !s.rules.some((r) => r.class !== "manual"),
        );
        return empty.length === 0
          ? result(true, "every spec declares a contract")
          : result(false, `no binding or enforceable rule in ${listOf(empty.map((s) => s.id))}`);
      }
      case "deps_known": {
        const unknown = specs.flatMap((s) =>
          s.dependsOn.filter((d) => !this.model.specs.get(d)).map((d) => `${s.id} → ${d}`),
        );
        const errors = this.model.diagnostics.filter(
          (d) => d.code === "CS0104" && d.spec !== undefined && ids.includes(d.spec),
        );
        return unknown.length === 0
          ? result(true, "every dependency exists")
          : result(false, `unknown dependencies: ${listOf(unknown)}`, errors);
      }
      case "deps_ready": {
        // For a stage over a whole feature, dependencies inside the feature move together.
        const inScope = new Set(stage.per === "feature" ? ids : []);
        const problems: string[] = [];
        const diagnostics: Diagnostic[] = [];
        const deps = [...new Set(specs.flatMap((s) => s.dependsOn))]
          .filter((d) => !inScope.has(d))
          .sort(compareStrings);
        for (const dep of deps) {
          const other = this.model.specs.get(dep);
          if (!other) problems.push(`${dep} does not exist`);
          else if (other.status !== "implemented") {
            problems.push(`${dep} is ${other.status}, not implemented`);
          } else {
            const check = await this.check([dep]);
            const errors = check.diagnostics.filter((d) => d.severity === "error");
            if (errors.length > 0) {
              problems.push(`${dep} is implemented but its contracts fail`);
              diagnostics.push(...errors);
            }
          }
        }
        return problems.length === 0
          ? result(true, deps.length > 0 ? `${listOf(deps)} implemented` : "no dependencies")
          : result(false, listOf(problems), diagnostics);
      }
      case "contracts_pass": {
        if (ids.length === 0) return result(true, "no spec to check");
        const check = await this.check(ids);
        const errors = check.diagnostics.filter((d) => d.severity === "error");
        const waiting = specs.flatMap((s) =>
          s.aggregate
            ? s.dependsOn
                .filter((d) => this.model.specs.get(d)?.status !== "implemented")
                .map((d) => `${s.id} waits for ${d} to be implemented`)
            : [],
        );
        const failing = [...new Set(errors.flatMap((d) => (d.spec ? [d.spec] : [])))].sort(
          compareStrings,
        );
        if (errors.length === 0 && waiting.length === 0) {
          return result(true, `${listOf(ids)}: DONE`);
        }
        const parts = [
          ...(failing.length > 0
            ? [`contracts fail in ${listOf(failing)} (run \`catspec check --spec <id>\`)`]
            : errors.length > 0
              ? [`${errors.length} error(s)`]
              : []),
          ...waiting,
        ];
        return result(false, parts.join("; "), errors);
      }
      case "tasks_done": {
        const open: string[] = [];
        if (stage.per === "spec") {
          for (const spec of specs) {
            const count = spec.body.tasks.filter((t) => !t.done).length;
            if (count > 0) open.push(`${spec.id}: ${count} open task(s) in ${spec.file}`);
          }
        } else if (feature) {
          const file = `${feature.dir}/tasks.md`;
          const text = (await this.model.source.read(file))?.toString("utf8");
          const count = text === undefined ? 0 : openCheckboxes(text);
          if (count > 0) open.push(`${count} open task(s) in ${file}`);
        }
        return open.length === 0
          ? result(true, "every task is ticked")
          : result(false, listOf(open));
      }
      case "no_drift": {
        if (ids.length === 0) return result(true, "no spec to check");
        const check = await this.check(ids);
        const drift = check.diagnostics.filter((d) => d.code === "CS0300" && d.severity !== "info");
        return drift.length === 0
          ? result(true, "no drift")
          : result(
              false,
              `drift in ${listOf([...new Set(drift.map((d) => d.spec ?? "?"))])}; run \`catspec accept <id>\` for an intended change`,
              drift,
            );
      }
      case "adr_valid": {
        const architecture = this.model.architecture;
        const errors = this.model.diagnostics.filter(
          (d) =>
            d.severity === "error" &&
            (d.code === "CS0107" ||
              d.code === "CS0112" ||
              (architecture !== undefined &&
                (d.spec === architecture.id || d.specLocation?.file === architecture.file))),
        );
        return errors.length === 0 && architecture
          ? result(true, `${architecture.file} is valid`)
          : result(
              false,
              architecture ? `${errors.length} error(s) in the ADR log` : "no ADR log",
              errors,
            );
      }
    }
  }

  private async commandGate(
    command: string,
    feature: Feature | undefined,
    specs: readonly Spec[],
    commands: boolean,
  ): Promise<GateResult> {
    const gate = `command: ${command}`;
    const args = testCommandArgs(command).flatMap((arg) =>
      arg.includes("{spec}")
        ? specs.map((s) => this.expand(arg, feature, [s])[0]!)
        : this.expand(arg, feature, specs),
    );
    if (!commands) {
      return { gate, passed: true, skipped: true, detail: "not run", diagnostics: [] };
    }
    if (!this.profile.allowCommands) {
      return {
        gate,
        passed: true,
        skipped: true,
        detail: "not run: workflow.allow_commands is false",
        diagnostics: [
          createDiagnostic("CS0706", {
            message: `the gate \`${args.join(" ")}\` was not run: workflow.allow_commands is false`,
            actual: args,
            suggestions: [
              { message: "run it yourself, or set workflow.allow_commands: true in catspec.yaml" },
            ],
          }),
        ],
      };
    }
    const run = await (this.options.runCommand ?? runCommand)(this.model.root, args);
    return run.exitCode === 0
      ? { gate, passed: true, detail: `\`${args.join(" ")}\` exited with 0`, diagnostics: [] }
      : {
          gate,
          passed: false,
          detail: `\`${args.join(" ")}\` exited with ${run.exitCode}${run.output ? `:\n${run.output}` : ""}`,
          diagnostics: [],
        };
  }

  /** Runs the gates of a transition. */
  async gates(
    transition: Transition,
    stage: Stage,
    feature: Feature | undefined,
    specs: readonly Spec[],
    commands: boolean,
  ): Promise<GateResult[]> {
    const results: GateResult[] = [];
    for (const gate of transition.gates) {
      results.push(await this.gate(gate, stage, feature, specs, commands));
    }
    return results;
  }

  // Stage resolution ------------------------------------------------------------------------

  /** True when a stage is done for these specs: finish gates pass and its status is reached. */
  async done(stage: Stage, feature: Feature | undefined, specs: readonly Spec[]): Promise<boolean> {
    const status = stageStatus(stage);
    if (status !== undefined && !specs.every((s) => reached(s.status, status))) return false;
    if (stage.per === "spec" && specs.length === 0) return true;
    const results = await this.gates(stage.finish, stage, feature, specs, false);
    return results.every((r) => r.passed);
  }

  /** Where a feature is: its current stage, and each work item's stage. */
  async position(feature: Feature): Promise<FeaturePosition> {
    const stages = this.profile.stages;
    const specs = feature.specs.filter((s) => s.status !== "deprecated");
    for (const [index, stage] of stages.entries()) {
      if (stage.per === "feature") {
        if (await this.done(stage, feature, specs)) continue;
        return { feature: feature.name, dir: feature.dir, stage, items: [] };
      }
      // A run of per-spec stages: each work item is at its own stage.
      let end = index;
      while (end < stages.length && stages[end]!.per === "spec") end++;
      const run = stages.slice(index, end);
      const items: ItemPosition[] = [];
      for (const spec of specs) items.push(await this.item(spec, run));
      const first = run.find((s) => items.some((i) => i.stage === s.id));
      if (first) return { feature: feature.name, dir: feature.dir, stage: first, items };
    }
    return { feature: feature.name, dir: feature.dir, items: [] };
  }

  /** A work item's stage among a run of per-spec stages, and whether it can start. */
  async item(spec: Spec, run: readonly Stage[]): Promise<ItemPosition> {
    const feature = this.featureOf(spec);
    let current: Stage | undefined;
    for (const stage of run) {
      if (!(await this.done(stage, feature, [spec]))) {
        current = stage;
        break;
      }
    }
    const waitingOn = spec.dependsOn
      .filter((d) => this.model.specs.get(d)?.status !== "implemented")
      .sort(compareStrings);
    const state: ItemPosition["state"] = !current
      ? "done"
      : spec.status === "in-progress"
        ? "in-progress"
        : waitingOn.length > 0
          ? "waiting"
          : "ready";
    return {
      spec: spec.id,
      status: spec.status,
      ...(current ? { stage: current.id } : {}),
      state,
      waitingOn: state === "waiting" ? waitingOn : [],
    };
  }

  /** The per-spec stages from a stage's run (the stages a work item goes through). */
  private specRun(stage: Stage): Stage[] {
    const stages = this.profile.stages;
    let start = stages.indexOf(stage);
    while (start > 0 && stages[start - 1]!.per === "spec") start--;
    let end = stages.indexOf(stage);
    while (end < stages.length && stages[end]!.per === "spec") end++;
    return stages.slice(start, end);
  }

  /** What to do next for a feature or a work item (`catspec next`, MCP `next_step`). */
  async next(name: string): Promise<NextStep> {
    const target = this.target(name);
    const spec = target.spec;
    if (!spec) {
      const feature = target.feature!;
      const position = await this.position(feature);
      return this.describeNext(name, feature, position.stage, position.items, feature.specs);
    }
    // One work item: the first stage not done for its feature (per-feature stages) or for it.
    const feature = target.feature;
    const all = feature?.specs.filter((s) => s.status !== "deprecated") ?? [];
    for (const stage of this.profile.stages) {
      if (stage.per === "feature") {
        if (!feature || (await this.done(stage, feature, all))) continue;
        return this.describeNext(name, feature, stage, [], [spec]);
      }
      if (await this.done(stage, feature, [spec])) continue;
      const item = await this.item(spec, this.specRun(stage));
      return this.describeNext(name, feature, stage, [item], [spec]);
    }
    const item = await this.item(spec, []);
    return this.describeNext(name, feature, undefined, [item], [spec]);
  }

  private describeNext(
    target: string,
    feature: Feature | undefined,
    stage: Stage | undefined,
    items: ItemPosition[],
    specs: readonly Spec[],
  ): NextStep {
    if (!stage) {
      return { target, ...(feature ? { feature: feature.name } : {}), done: true, items };
    }
    const index = this.profile.stages.indexOf(stage);
    const inputs = [
      ...this.profile.context.filter((f) => this.files.includes(f)),
      ...this.profile.stages
        .slice(0, index)
        .flatMap((s) => s.produces.flatMap((t) => this.expand(t, feature, specs)))
        .flatMap((p) => this.existing(p)),
      ...(stage.per === "spec" ? specs.map((s) => s.file) : []),
    ];
    return {
      target,
      ...(feature ? { feature: feature.name } : {}),
      done: false,
      stage: describeStage(stage),
      inputs: [...new Set(inputs)],
      produces: stage.produces.flatMap((t) => this.expand(t, feature, specs)),
      items,
    };
  }

  /**
   * The stages before `stage` that aren't done for the target (CS0705): earlier per-feature stages
   * for the feature, earlier per-spec stages for each spec.
   */
  private async outOfOrder(
    stage: Stage,
    feature: Feature | undefined,
    specs: readonly Spec[],
  ): Promise<string[]> {
    const pending: string[] = [];
    for (const earlier of this.profile.stages.slice(0, this.profile.stages.indexOf(stage))) {
      if (earlier.per === "feature") {
        if (!feature) continue;
        const all = feature.specs.filter((s) => s.status !== "deprecated");
        if (!(await this.done(earlier, feature, all))) pending.push(earlier.id);
      } else {
        const behind = [];
        for (const spec of specs) {
          if (!(await this.done(earlier, this.featureOf(spec), [spec]))) behind.push(spec.id);
        }
        if (behind.length > 0) pending.push(`${earlier.id} (${listOf(behind)})`);
      }
    }
    return pending;
  }

  /**
   * `catspec stage start|finish <stage> <target>`: checks the order (CS0705) and the gates
   * (CS0701, CS0702), then works out the status change. Nothing is written: `writeStage` does
   * that. With `force`, failures become warnings and the run is marked forced; `implemented` is
   * still never set while a spec's contracts fail.
   */
  async run(
    phase: Phase,
    stageId: string,
    targetName: string,
    options: { force?: boolean } = {},
  ): Promise<StageRun> {
    const stage = this.stage(stageId);
    const target = this.target(targetName);
    const { feature, specs } = this.scope(stage, target);
    const force = Boolean(options.force);
    const transition = stage[phase];
    const diagnostics: Diagnostic[] = [];
    const where = `${stage.id} ${targetName}`;
    const failCode = phase === "start" ? "CS0701" : "CS0702";

    const pending = await this.outOfOrder(stage, feature, specs);
    if (pending.length > 0) {
      diagnostics.push(
        createDiagnostic("CS0705", {
          ...(force ? { severity: "warning" as const } : {}),
          message: `stage "${stage.id}" for "${targetName}" is out of order: ${listOf(pending)} not done yet`,
          expected: "every earlier stage done",
          actual: pending,
          suggestions: [
            {
              message: `run \`catspec next ${feature?.name ?? targetName}\` to see the current stage`,
            },
          ],
        }),
      );
    }

    const gates = await this.gates(transition, stage, feature, specs, true);
    for (const gate of gates) {
      diagnostics.push(...gate.diagnostics.filter((d) => d.code === "CS0706"));
      if (gate.passed) continue;
      diagnostics.push(
        createDiagnostic(failCode, {
          ...(force ? { severity: "warning" as const } : {}),
          message: `stage "${stage.id}" can't ${phase} for "${targetName}": gate ${gate.gate} failed: ${gate.detail}`,
          expected: gate.gate,
          actual: gate.detail,
          suggestions: [{ message: `fix it, then run \`catspec stage ${phase} ${where}\` again` }],
        }),
        ...gate.diagnostics,
      );
    }

    const blocked = diagnostics.some((d) => d.severity === "error");
    const changes: StatusChange[] = [];
    if (transition.status !== undefined && !blocked) {
      const status = transition.status;
      const inScope = new Set(specs.map((s) => s.id));
      for (const spec of specs) {
        if (reached(spec.status, status)) continue;
        // Dependencies inside a per-feature stage move together; statusGate checks the rest.
        const outside: Spec =
          stage.per === "feature"
            ? { ...spec, dependsOn: spec.dependsOn.filter((d) => !inScope.has(d)) }
            : spec;
        const gate = await statusGate(this.model, this.codebase, outside, status, {
          force,
          ...(this.options.now ? { now: this.options.now } : {}),
        });
        if (!gate.allowed) {
          diagnostics.push(...gate.diagnostics);
          continue;
        }
        changes.push({
          spec: spec.id,
          file: spec.file,
          from: spec.status,
          to: status,
          text: applyPatch(spec.source, [{ op: "set", path: ["status"], value: status }]),
        });
      }
    }

    const ok = !diagnostics.some((d) => d.severity === "error");
    return {
      phase,
      stage: describeStage(stage),
      target: targetName,
      ...(feature ? { feature: feature.name } : {}),
      specs: specs.map((s) => s.id),
      gates: gates.map(({ gate, passed, skipped, detail }) => ({
        gate,
        passed,
        ...(skipped ? { skipped } : {}),
        detail,
      })),
      produces: stage.produces.flatMap((t) => this.expand(t, feature, specs)),
      ok,
      forced: force && diagnostics.some((d) => d.severity === "warning" && FORCED.has(d.code)),
      changes: ok ? changes : [],
      diagnostics: sortDiagnostics(diagnostics),
    };
  }
}

const FORCED = new Set(["CS0701", "CS0702", "CS0705"]);

/** Open checkboxes (`- [ ]`) in a Markdown file, outside code fences. */
export function openCheckboxes(markdown: string): number {
  let fenced = false;
  let count = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^\s*(?:[-*+]|\d+[.)])\s+\[ \]/.test(line)) count++;
  }
  return count;
}

export interface StageInfo {
  id: string;
  per: Stage["per"];
  driver: Driver;
  /** The driver in words: "skill sdd-plan", "slash command /opsx:apply". */
  driverText: string;
  start: { gates: string[]; status?: SpecStatus };
  finish: { gates: string[]; status?: SpecStatus };
}

export const describeStage = (stage: Stage): StageInfo => ({
  id: stage.id,
  per: stage.per,
  driver: stage.driver,
  driverText: driverText(stage.driver),
  start: {
    gates: stage.start.gates.map(gateName),
    ...(stage.start.status ? { status: stage.start.status } : {}),
  },
  finish: {
    gates: stage.finish.gates.map(gateName),
    ...(stage.finish.status ? { status: stage.finish.status } : {}),
  },
});

export interface ItemPosition {
  spec: string;
  status: SpecStatus;
  /** Its current stage; absent when it went through every stage. */
  stage?: string;
  /** ready: can start; waiting: on dependencies not implemented yet. */
  state: "ready" | "waiting" | "in-progress" | "done";
  waitingOn: string[];
}

export interface FeaturePosition {
  feature: string;
  dir: string;
  /** The current stage; absent when the feature went through every stage. */
  stage?: Stage;
  /** Each work item's stage, while the current stage runs per spec. */
  items: ItemPosition[];
}

export interface NextStep {
  target: string;
  feature?: string;
  /** Every stage is done. */
  done: boolean;
  stage?: StageInfo;
  /** Files to read first: the earlier stages' artifacts, the work items, extra context. */
  inputs?: string[];
  /** Files the stage must leave behind. */
  produces?: string[];
  items: ItemPosition[];
}

export interface StatusChange {
  spec: string;
  file: string;
  from: SpecStatus;
  to: SpecStatus;
  /** The spec file with the new status. */
  text: string;
}

export interface StageRun {
  phase: Phase;
  stage: StageInfo;
  target: string;
  feature?: string;
  specs: string[];
  gates: { gate: string; passed: boolean; skipped?: boolean; detail: string }[];
  produces: string[];
  /** No errors: the stage may start or finish. */
  ok: boolean;
  /** `--force` let failing gates or the order through. */
  forced: boolean;
  /** Status changes to write (none unless `ok`). */
  changes: StatusChange[];
  diagnostics: Diagnostic[];
}

/**
 * Writes a stage run's status changes, and logs a forced run in the runtime store
 * (`<git-common-dir>/catspec/workflow-overrides.log`, ADR-004).
 */
export async function writeStage(root: string, run: StageRun, now = new Date()): Promise<void> {
  for (const change of run.changes) await writeFile(join(root, change.file), change.text, "utf8");
  if (!run.forced) return;
  const common = findGitCommonDir(root);
  if (!common) return;
  const dir = join(common, "catspec");
  await mkdir(dir, { recursive: true });
  const entry = {
    at: now.toISOString(),
    phase: run.phase,
    stage: run.stage.id,
    target: run.target,
    overridden: run.diagnostics
      .filter((d) => FORCED.has(d.code))
      .map((d) => `${d.code} ${d.message}`),
  };
  await appendFile(join(dir, "workflow-overrides.log"), `${JSON.stringify(entry)}\n`, "utf8");
}

/** Runs a `command:` gate without a shell (ADR-009). */
export function runCommand(
  root: string,
  args: string[],
  timeoutMs = 10 * 60_000,
): Promise<{ exitCode: number; output: string }> {
  const [file, ...rest] = args;
  return new Promise((resolve) => {
    execFile(
      file!,
      rest,
      { cwd: root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim().split(/\r?\n/).slice(-20).join("\n");
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ exitCode: code, output: error && !output ? error.message : output });
      },
    );
  });
}
