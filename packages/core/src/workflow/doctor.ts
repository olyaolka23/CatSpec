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

/**
 * Where a program is: a path (relative to `root`), or the first match on PATH, with the PATHEXT
 * extensions on Windows. Undefined when it isn't found.
 */
export function findProgram(
  name: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (name.includes("/") || name.includes("\\")) {
    const path = isAbsolute(name) ? name : join(root, name);
    return existsSync(path) ? path : undefined;
  }
  const extensions =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())]
      : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const file = join(dir, name + ext);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** True when `name` is a program on PATH (or a path to a file). */
export const onPath = (name: string, root: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  findProgram(name, root, env) !== undefined;

/**
 * A Windows batch script (`.cmd`, `.bat`, e.g. an npm shim): Node can't start one without a
 * shell, and CatSpec runs commands without one (ADR-009).
 */
export const isBatchScript = (path: string): boolean => /\.(cmd|bat)$/i.test(path);

/** Where agent skills usually live: Claude Code's folder, then the one shared by all agents. */
export const SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;

/** The `sdd-*` skill folders of a skills folder, sorted. */
const sddSkillsIn = (root: string, skillsDir: string): string[] => {
  const dir = join(root, skillsDir);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.startsWith("sdd-"))
        .sort()
    : [];
};

/** The first of `SKILL_DIRS` with `sdd-*` skills, and those skills. */
export function findSddSkills(root: string): { skillsDir: string; skills: string[] } | undefined {
  for (const skillsDir of SKILL_DIRS) {
    const skills = sddSkillsIn(root, skillsDir);
    if (skills.length > 0) return { skillsDir, skills };
  }
  return undefined;
}

/**
 * The SDD workflow a repository already uses, by what is on disk (plan §D17.3). `sdd-*` skills
 * are looked for in `skillsDir`, or in each of `SKILL_DIRS` without it.
 */
export function detectPreset(root: string, skillsDir?: string): PresetName | undefined {
  if (existsSync(join(root, "openspec"))) return "openspec";
  if (existsSync(join(root, ".specify"))) return "spec-kit";
  const found = skillsDir ? sddSkillsIn(root, skillsDir).length > 0 : findSddSkills(root);
  return found ? "custom" : undefined;
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
        const found = findProgram(program, root, options.env);
        if (found && process.platform === "win32" && isBatchScript(found)) {
          diagnostics.push(
            createDiagnostic("CS0704", {
              severity: "warning",
              ...location(["stages", index, phase, "gates", g]),
              message: `stage "${stage.id}": the ${phase} gate \`${gate.command}\` would start ${found}, a batch script, which CatSpec can't run without a shell; run the command yourself`,
              actual: found,
            }),
          );
          continue;
        }
        if (found) continue;
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

/** True when a stage writes the machine specs (`*.spec.md`), so its agent writes the contract. */
export const writesSpecs = (stage: Stage): boolean =>
  stage.produces.some((p) => p.endsWith(".spec.md")) ||
  stage.finish.gates.includes("contracts_declared");

/**
 * How the agent of a stage that writes the machine specs writes them: CatSpec never calls an AI,
 * so the spec-writing skill or prompt says what goes into `<spec-id>.spec.md`.
 */
export const SPEC_WRITING_STEP =
  "Next to the feature's spec, write `<spec-id>.spec.md`: in its YAML header, list as `bindings` " +
  "every class, interface and method this feature adds or changes, and under `rules` what must " +
  "stay true. `catspec guide spec-format` and `catspec guide rules` show the format; for a class " +
  "that already exists, `catspec bind <ClassName> --spec <spec-id>` writes its contract.";

/** `catspec workflow snippet <stage>`: the lines to paste into the stage's skill. */
export function stageSnippet(stage: Stage): string {
  const target = targetWord(stage);
  return [
    `First run \`catspec stage start ${stage.id} ${target}\`. If it fails, stop and report what it says.`,
    ...(writesSpecs(stage) ? [SPEC_WRITING_STEP] : []),
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

/**
 * The `feature_dir:` line `catspec init` writes, with a commented example of a list, for features
 * at several depths (domain folders). The example is a comment, so it never names a missing folder.
 */
export const featureDirYaml = (featureDir: string): string =>
  [
    "  # Where features live. A list for features at several depths, e.g.",
    `  # feature_dir: ["${featureDir.replace("{feature}", "billing/{feature}")}", "${featureDir}"]`,
    `  feature_dir: "${featureDir}"`,
  ].join("\n");

/**
 * The `custom` preset's stages as YAML, for `catspec init` (plan §D17.2). Each stage uses the
 * repository's skill of its name (`sdd-task`, or the plural `sdd-tasks`) from `skills`; a stage
 * without one gets a manual driver, so the new config passes `catspec workflow doctor`.
 */
export const customWorkflowYaml = (
  skills: readonly string[] = SDD_SKILLS,
  skillsDir = ".claude/skills",
): string => {
  const driver = (name: string): string => {
    const skill = skills.find((s) => s === name || s === `${name}s`);
    return skill
      ? `      driver: { skill: ${skill} }`
      : `      driver: manual  # no ${name} skill found; name your skill here: { skill: <name> }`;
  };
  return [
    "workflow:",
    "  preset: custom",
    featureDirYaml("docs/spec/{feature}"),
    `  skills_dir: "${skillsDir}"  # where \`skill:\` drivers are found`,
    "  stages:",
    "    - id: spec",
    "      per: feature",
    driver(SDD_SKILLS[0]),
    '      produces: ["{feature_dir}/spec.md", "{feature_dir}/*.spec.md"]',
    "      finish: { gates: [specs_valid, artifacts, contracts_declared] }",
    "    - id: plan",
    "      per: feature",
    driver(SDD_SKILLS[1]),
    '      produces: ["{feature_dir}/plan.md"]',
    "      finish: { gates: [artifacts, deps_known], status: ready }",
    "    - id: task",
    "      per: spec",
    driver(SDD_SKILLS[2]),
    "      start: { gates: [deps_ready], status: in-progress }",
    "      finish: { gates: [contracts_pass] }",
    "    - id: close",
    "      per: spec",
    driver(SDD_SKILLS[3]),
    "      finish: { gates: [contracts_pass, tasks_done, no_drift], status: implemented }",
    "",
  ].join("\n");
};
