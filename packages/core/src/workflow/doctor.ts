/**
 * `catspec workflow doctor`, `workflow snippet` and preset detection (plan §D17.3, §D17.5), PBIs
 * `workflow-cli`, `workflow-presets` and `workflow-hook`: checks that the workflow fits the
 * repository, prints the lines to paste into a skill, finds an existing SDD workflow for
 * `catspec init`, and the final gates the pre-commit hook re-checks (CS0703).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { LineCounter, parseDocument } from "yaml";

import {
  createDiagnostic,
  sortDiagnostics,
  type Diagnostic,
  type Location,
} from "../diagnostics.js";
import type { SpecModel } from "../load.js";
import { locate } from "../schema-issues.js";
import type { Spec } from "../spec.js";
import { testCommandArgs } from "../check.js";
import { listOf } from "../util.js";
import {
  gateName,
  SDD_SKILLS,
  type BuiltinGate,
  type PresetName,
  type Stage,
  type Transition,
  type WorkflowProfile,
} from "./schema.js";

/** Where a `workflow.stages[i]` key is in the config file, when the config lists the stages. */
function configLocator(
  configFile: { path: string; text: string } | undefined,
): (path: (string | number)[]) => Location | undefined {
  if (!configFile) return () => undefined;
  const lineCounter = new LineCounter();
  const doc = parseDocument(configFile.text, { lineCounter });
  return (path) => {
    if (!doc.hasIn(["workflow", ...path.slice(0, 2)])) return undefined;
    const range = locate(doc, ["workflow", ...path]);
    if (!range) return undefined;
    const { line, col } = lineCounter.linePos(range.start);
    return { file: configFile.path, line, column: col };
  };
}

/** True when `name` is a program on PATH (or a path to a file). */
export function onPath(name: string, root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(isAbsolute(name) ? name : join(root, name));
  }
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())]
      : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) =>
    extensions.some((ext) => {
      const file = join(dir, name + ext);
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    }),
  );
}

/** The SDD workflow a repository already uses, by what is on disk (plan §D17.3). */
export function detectPreset(root: string, skillsDir = ".claude/skills"): PresetName | undefined {
  if (existsSync(join(root, "openspec"))) return "openspec";
  if (existsSync(join(root, ".specify"))) return "spec-kit";
  const skills = join(root, skillsDir);
  if (existsSync(skills)) {
    const names = readdirSync(skills);
    if (names.some((n) => n.startsWith("sdd-"))) return "custom";
  }
  return undefined;
}

/** The skill file a `skill:` driver needs. */
export const skillFile = (profile: WorkflowProfile, name: string): string =>
  `${profile.skillsDir}/${name}/SKILL.md`;

/**
 * `catspec workflow doctor`: every skill exists (CS0704), every command is on PATH (CS0704), and
 * the preset matches the repository (CS0700 warnings).
 */
export function workflowDoctor(
  root: string,
  profile: WorkflowProfile,
  options: { configFile?: { path: string; text: string }; env?: NodeJS.ProcessEnv } = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const at = configLocator(options.configFile);
  const location = (path: (string | number)[]) => {
    const found = at(path);
    return found ? { specLocation: found } : {};
  };
  for (const [index, stage] of profile.stages.entries()) {
    const driver = stage.driver;
    if (driver.kind === "skill") {
      const file = skillFile(profile, driver.name);
      if (!existsSync(join(root, file))) {
        diagnostics.push(
          createDiagnostic("CS0704", {
            ...location(["stages", index, "driver", "skill"]),
            message: `stage "${stage.id}": skill ${driver.name} not found; expected ${file}`,
            expected: file,
            actual: driver.name,
            suggestions: [
              {
                message: `create ${file}, fix the skill name, or set workflow.skills_dir in catspec.yaml`,
              },
            ],
          }),
        );
      }
    } else if (driver.kind === "command") {
      const program = testCommandArgs(driver.command)[0]!;
      if (!onPath(program, root, options.env)) {
        diagnostics.push(
          createDiagnostic("CS0704", {
            ...location(["stages", index, "driver", "command"]),
            message: `stage "${stage.id}": command ${program} is not installed (not on PATH)`,
            actual: program,
            suggestions: [{ message: `install ${program}, or change the stage's driver` }],
          }),
        );
      }
    }
    for (const phase of ["start", "finish"] as const) {
      for (const [g, gate] of stage[phase].gates.entries()) {
        if (typeof gate === "string") continue;
        const program = testCommandArgs(gate.command)[0]!;
        if (onPath(program, root, options.env)) continue;
        diagnostics.push(
          createDiagnostic("CS0704", {
            ...(profile.allowCommands ? {} : { severity: "warning" as const }),
            ...location(["stages", index, phase, "gates", g]),
            message: `stage "${stage.id}": the ${phase} gate \`${gate.command}\` needs ${program}, which is not installed (not on PATH)`,
            actual: program,
            suggestions: [{ message: `install ${program}, or remove the gate` }],
          }),
        );
      }
    }
  }

  const detected = detectPreset(root, profile.skillsDir);
  const expected: Partial<Record<PresetName, string>> = {
    openspec: "openspec/",
    "spec-kit": ".specify/",
  };
  const folder = expected[profile.preset];
  if (folder && !existsSync(join(root, folder))) {
    diagnostics.push(
      createDiagnostic("CS0700", {
        severity: "warning",
        ...location(["preset"]),
        message: `workflow.preset is ${profile.preset}, but the repository has no ${folder} folder`,
        expected: folder,
        suggestions: [{ message: `set up ${profile.preset}, or change workflow.preset` }],
      }),
    );
  } else if (detected && detected !== profile.preset && profile.preset === "catspec") {
    diagnostics.push(
      createDiagnostic("CS0700", {
        severity: "warning",
        ...location(["preset"]),
        message: `the repository looks like it uses ${detected === "custom" ? "sdd-* skills" : detected}, but workflow.preset is catspec`,
        actual: detected,
        suggestions: [{ message: `set workflow.preset: ${detected} in catspec.yaml` }],
      }),
    );
  }
  return sortDiagnostics(diagnostics);
}

/** `<feature>` or `<spec-id>`: what a stage command is run for. */
const targetWord = (stage: Stage): string => (stage.per === "spec" ? "<spec-id>" : "<feature>");

/** `catspec workflow snippet <stage>`: the lines to paste into the stage's skill. */
export function stageSnippet(stage: Stage): string {
  const target = targetWord(stage);
  return [
    `First run \`catspec stage start ${stage.id} ${target}\`. If it fails, stop and report what it says.`,
    `End with \`catspec stage finish ${stage.id} ${target}\` and fix everything it reports until it passes.`,
  ].join("\n");
}

/**
 * The steps of the `AGENTS.md` block (plan §D14.3) for this workflow: the stage that puts a work
 * item in progress, then the commands that finish it up to `implemented`.
 */
export function agentSteps(profile: WorkflowProfile): { begin: string; end: string[] } {
  const stages = profile.stages;
  const work = stages.findIndex(
    (s) => s.start.status === "in-progress" || s.finish.status === "in-progress",
  );
  if (work < 0) {
    return { begin: "catspec status <id> in-progress", end: ["catspec status <id> implemented"] };
  }
  const workStage = stages[work]!;
  const target = (s: Stage) => (s.per === "spec" ? "<id>" : "<feature>");
  const begin =
    workStage.start.status === "in-progress"
      ? `catspec stage start ${workStage.id} ${target(workStage)}`
      : `catspec stage finish ${workStage.id} ${target(workStage)}`;
  const end: string[] = [];
  for (const stage of stages.slice(work)) {
    if (stage !== workStage && (stage.start.gates.length > 0 || stage.start.status)) {
      end.push(`catspec stage start ${stage.id} ${target(stage)}`);
    }
    if (stage.finish.gates.length > 0 || stage.finish.status) {
      end.push(`catspec stage finish ${stage.id} ${target(stage)}`);
    }
    if (stageSetsImplemented(stage)) break;
  }
  return { begin, end };
}

const stageSetsImplemented = (stage: Stage): boolean =>
  stage.start.status === "implemented" || stage.finish.status === "implemented";

/**
 * The final gates (plan §D17.5): those of the transition that sets `implemented`, else the last
 * stage's finish gates.
 */
export function finalGates(
  profile: WorkflowProfile,
): { stage: Stage; transition: Transition } | undefined {
  for (const stage of [...profile.stages].reverse()) {
    if (stage.finish.status === "implemented") return { stage, transition: stage.finish };
    if (stage.start.status === "implemented") return { stage, transition: stage.start };
  }
  const last = profile.stages.at(-1);
  return last ? { stage: last, transition: last.finish } : undefined;
}

/** Gates the hook can decide from a check it already ran (never `command:` or file lookups). */
const HOOK_GATES = new Set<BuiltinGate>([
  "specs_valid",
  "contracts_pass",
  "tasks_done",
  "no_drift",
  "deps_known",
  "contracts_declared",
]);

/**
 * CS0703 for the pre-commit hook (`workflow.enforce_in_hook`): `implemented` specs among `specs`
 * that no longer pass their final stage's built-in gates, decided from the diagnostics the staged
 * check computed. `command:` gates never run here.
 */
export function hookWorkflowDiagnostics(
  model: SpecModel,
  profile: WorkflowProfile,
  specs: readonly Spec[],
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  if (profile.enforceInHook === "off") return [];
  const final = finalGates(profile);
  if (!final) return [];
  const severity = profile.enforceInHook === "error" ? "error" : "warning";
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    if (spec.status !== "implemented" || !spec.valid || spec.type === "architecture") continue;
    const own = diagnostics.filter((d) => d.spec === spec.id);
    const failed: string[] = [];
    for (const gate of final.transition.gates) {
      if (typeof gate !== "string" || !HOOK_GATES.has(gate)) continue;
      const passes = (() => {
        switch (gate) {
          case "specs_valid":
            return !model.diagnostics.some((d) => d.spec === spec.id && d.severity === "error");
          case "contracts_pass":
            return !own.some((d) => d.severity === "error");
          case "tasks_done":
            return spec.body.tasks.every((t) => t.done);
          case "no_drift":
            return !own.some((d) => d.code === "CS0300" && d.severity !== "info");
          case "deps_known":
            return spec.dependsOn.every((d) => model.specs.get(d));
          default:
            return (
              spec.aggregate ||
              spec.bindings.length > 0 ||
              spec.rules.some((r) => r.class !== "manual")
            );
        }
      })();
      if (!passes) failed.push(gateName(gate));
    }
    if (failed.length === 0) continue;
    out.push(
      createDiagnostic("CS0703", {
        severity,
        spec: spec.id,
        specLocation: { file: spec.file, line: 1, column: 1 },
        message: `"${spec.id}" is implemented but no longer passes the ${final.stage.id} gates: ${listOf(failed)}`,
        expected: final.transition.gates.map(gateName),
        actual: failed,
        suggestions: [
          { message: "fix the code or the spec, or move the spec back to in-progress" },
        ],
      }),
    );
  }
  return out;
}

/** The `custom` preset's stages as YAML, for `catspec init` (plan §D17.2). */
export const customWorkflowYaml = (): string =>
  [
    "workflow:",
    "  preset: custom",
    '  feature_dir: "docs/spec/{feature}"',
    '  skills_dir: ".claude/skills"',
    "  stages:",
    "    - id: spec",
    "      per: feature",
    `      driver: { skill: ${SDD_SKILLS[0]} }`,
    '      produces: ["{feature_dir}/spec.md", "{feature_dir}/*.spec.md"]',
    "      finish: { gates: [specs_valid, artifacts, contracts_declared] }",
    "    - id: plan",
    "      per: feature",
    `      driver: { skill: ${SDD_SKILLS[1]} }`,
    '      produces: ["{feature_dir}/plan.md"]',
    "      finish: { gates: [artifacts, deps_known], status: ready }",
    "    - id: task",
    "      per: spec",
    `      driver: { skill: ${SDD_SKILLS[2]} }`,
    "      start: { gates: [deps_ready], status: in-progress }",
    "      finish: { gates: [contracts_pass] }",
    "    - id: close",
    "      per: spec",
    `      driver: { skill: ${SDD_SKILLS[3]} }`,
    "      finish: { gates: [contracts_pass, tasks_done, no_drift], status: implemented }",
    "",
  ].join("\n");
