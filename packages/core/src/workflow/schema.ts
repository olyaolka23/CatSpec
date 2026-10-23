/**
 * The `workflow:` section of `catspec.yaml` (plan §D17.1–§D17.3), PBIs `workflow-config` and
 * `workflow-presets`: stages, who drives them, what they produce, and the gates and status
 * transitions that apply when a stage starts and finishes. A preset fills in every key; the
 * config can still override any of them (`stages` replaces the preset's list as a whole).
 *
 * The section is validated with the rest of the config; its problems are config errors with the
 * code CS0700.
 */
import * as z from "zod";

import { SPEC_STATUSES, type SpecStatus } from "../spec-schema.js";

export const PRESETS = ["catspec", "openspec", "spec-kit", "custom"] as const;
export type PresetName = (typeof PRESETS)[number];

/** The built-in gates (plan §D17.4). */
export const GATES = [
  "specs_valid",
  "artifacts",
  "contracts_declared",
  "deps_known",
  "deps_ready",
  "contracts_pass",
  "tasks_done",
  "no_drift",
  "adr_valid",
] as const;
export type BuiltinGate = (typeof GATES)[number];

/** Placeholders of path templates and `command:` gates. */
export const PLACEHOLDERS = ["{feature}", "{feature_dir}", "{spec}"] as const;

const PLACEHOLDER = /\{[^{}]*\}/g;

/** The placeholders in `text` that aren't valid. */
export const unknownPlaceholders = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER)]
    .map((m) => m[0])
    .filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p));

const template = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    for (const placeholder of unknownPlaceholders(value)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown placeholder "${placeholder}"; valid: ${PLACEHOLDERS.join(", ")}`,
      });
    }
  });

const GateSchema = z.union([
  z.enum(GATES),
  z.strictObject({
    command: template.describe(
      "A command that must exit with 0, run without a shell; only with workflow.allow_commands.",
    ),
  }),
]);

const TransitionSchema = z
  .strictObject({
    gates: z.array(GateSchema).default([]).describe("Gates that must pass."),
    status: z
      .enum(SPEC_STATUSES)
      .optional()
      .describe("The status the stage's specs get when the gates pass."),
  })
  .prefault({});

const DriverSchema = z
  .union([
    z.literal("manual"),
    z.strictObject({ skill: z.string().min(1).describe("An agent skill, in skills_dir.") }),
    z.strictObject({ slash: z.string().min(1).describe("An agent slash command.") }),
    z.strictObject({ command: template.describe("A command the person or agent runs.") }),
    z.strictObject({ manual: z.string().min(1).describe("What the person does.") }),
  ])
  .describe("Who performs the stage.");

const StageSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, { error: "must be lowercase letters, digits and '-'" }),
  per: z
    .enum(["feature", "spec"])
    .default("feature")
    .describe("feature: once for the feature folder; spec: once per work item (spec)."),
  driver: DriverSchema.default("manual"),
  produces: z.array(template).default([]).describe("Path templates of the stage's artifacts."),
  start: TransitionSchema,
  finish: TransitionSchema,
});

export const WorkflowSchema = z
  .strictObject({
    preset: z.enum(PRESETS).default("catspec").describe("A ready-made profile, or custom."),
    allow_commands: z
      .boolean()
      .default(false)
      .describe("Let `command:` gates run commands (without a shell)."),
    enforce_in_hook: z
      .enum(["off", "warn", "error"])
      .default("warn")
      .describe("Re-check implemented specs' final gates in the pre-commit hook (CS0703)."),
    feature_dir: template.optional().describe('Where features live, e.g. "docs/spec/{feature}".'),
    skills_dir: z.string().min(1).optional().describe("Where `skill:` drivers are found."),
    stages: z
      .array(StageSchema)
      .min(1)
      .optional()
      .describe("The stages, in order; replaces the preset's stages."),
  })
  .superRefine((value, ctx) => {
    const dir = value.feature_dir;
    if (dir !== undefined && (dir.split("{feature}").length !== 2 || dir.includes("{spec}"))) {
      ctx.addIssue({
        code: "custom",
        path: ["feature_dir"],
        message:
          'feature_dir must contain "{feature}" exactly once and no "{spec}", e.g. "docs/spec/{feature}"',
      });
    }
    const seen = new Set<string>();
    for (const [index, stage] of (value.stages ?? []).entries()) {
      if (seen.has(stage.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", index, "id"],
          message: `duplicate stage id "${stage.id}"`,
        });
      }
      seen.add(stage.id);
    }
  })
  .describe("Workflow profile (plan §D17).");

export type WorkflowInput = z.output<typeof WorkflowSchema>;

export type Gate = BuiltinGate | { command: string };

export type Driver =
  | { kind: "skill"; name: string }
  | { kind: "slash"; name: string }
  | { kind: "command"; command: string }
  | { kind: "manual"; text?: string };

export interface Transition {
  gates: Gate[];
  status?: SpecStatus;
}

export interface Stage {
  id: string;
  per: "feature" | "spec";
  driver: Driver;
  produces: string[];
  start: Transition;
  finish: Transition;
}

/** The workflow in effect: the preset with the config's overrides. */
export interface WorkflowProfile {
  preset: PresetName;
  /** The version of the third-party tool layout the preset follows. */
  presetVersion?: string;
  allowCommands: boolean;
  enforceInHook: "off" | "warn" | "error";
  featureDir: string;
  skillsDir: string;
  stages: Stage[];
  /** Folder names under the feature folder's parent that aren't features (OpenSpec's archive). */
  notFeatures: string[];
  /** Files every stage passes to agents as extra context (Spec Kit's constitution). */
  context: string[];
  /** The `specs.include` default that matches this workflow's feature folders. */
  specsInclude: string[];
  /** The `layout` default: `free` when specs move out of their feature folder (OpenSpec). */
  layout: "feature-folders" | "free";
}

export const gateName = (gate: Gate): string =>
  typeof gate === "string" ? gate : `command: ${gate.command}`;

export const driverText = (driver: Driver): string => {
  switch (driver.kind) {
    case "skill":
      return `skill ${driver.name}`;
    case "slash":
      return `slash command ${driver.name}`;
    case "command":
      return `command \`${driver.command}\``;
    case "manual":
      return driver.text ? `manual: ${driver.text}` : "manual";
  }
};

const driverOf = (input: z.output<typeof DriverSchema>): Driver => {
  if (input === "manual") return { kind: "manual" };
  if ("skill" in input) return { kind: "skill", name: input.skill };
  if ("slash" in input) return { kind: "slash", name: input.slash };
  if ("command" in input) return { kind: "command", command: input.command };
  return { kind: "manual", text: input.manual };
};

const transition = (gates: Gate[], status?: SpecStatus): Transition =>
  status === undefined ? { gates } : { gates, status };

const stage = (
  id: string,
  per: Stage["per"],
  driver: Driver,
  produces: string[],
  start: Transition,
  finish: Transition,
): Stage => ({ id, per, driver, produces, start, finish });

/** The stages of CatSpec's own flow (plan §D17.2) with the given drivers. */
const catspecStages = (drivers: Record<"spec" | "plan" | "task" | "close", Driver>): Stage[] => [
  stage(
    "spec",
    "feature",
    drivers.spec,
    ["{feature_dir}/spec.md", "{feature_dir}/*.spec.md"],
    transition([]),
    transition(["specs_valid", "artifacts", "contracts_declared"]),
  ),
  stage(
    "plan",
    "feature",
    drivers.plan,
    ["{feature_dir}/plan.md"],
    transition([]),
    transition(["artifacts", "deps_known"], "ready"),
  ),
  stage(
    "task",
    "spec",
    drivers.task,
    [],
    transition(["deps_ready"], "in-progress"),
    transition(["contracts_pass"]),
  ),
  stage(
    "close",
    "spec",
    drivers.close,
    [],
    transition([]),
    transition(["contracts_pass", "tasks_done", "no_drift"], "implemented"),
  ),
];

type Preset = Omit<WorkflowProfile, "allowCommands" | "enforceInHook" | "preset">;

/**
 * The presets (plan §D17.3). Third-party layouts and command names were checked on 2026-10-22:
 * OpenSpec 1.x (`/opsx:*` slash commands, `openspec validate`, changes archived to
 * `openspec/changes/archive/<date>-<name>/`) and Spec Kit (`/speckit.*` commands, feature folders
 * `specs/<NNN-name>/`, constitution in `.specify/memory/constitution.md`).
 */
export const PRESET_PROFILES: Record<Exclude<PresetName, "custom">, Preset> = {
  catspec: {
    featureDir: "docs/spec/{feature}",
    skillsDir: ".claude/skills",
    stages: catspecStages({
      spec: {
        kind: "manual",
        text: "write spec.md and the *.spec.md work items (MCP prompt stage-spec)",
      },
      plan: {
        kind: "manual",
        text: "order the work items and write plan.md (MCP prompt stage-plan)",
      },
      task: { kind: "manual", text: "implement the work item (MCP prompt stage-task)" },
      close: {
        kind: "manual",
        text: "tick the tasks and close the work item (MCP prompt stage-close)",
      },
    }),
    notFeatures: [],
    context: [],
    specsInclude: ["docs/spec/*/*.spec.md"],
    layout: "feature-folders",
  },
  openspec: {
    presetVersion: "openspec-1",
    featureDir: "openspec/changes/{feature}",
    skillsDir: ".claude/skills",
    stages: [
      stage(
        "proposal",
        "feature",
        { kind: "slash", name: "/opsx:propose" },
        ["{feature_dir}/proposal.md", "{feature_dir}/tasks.md"],
        transition([]),
        transition(["artifacts", { command: "openspec validate {feature}" }, "specs_valid"]),
      ),
      stage(
        "apply",
        "feature",
        { kind: "slash", name: "/opsx:apply" },
        [],
        transition(["deps_ready"], "in-progress"),
        transition([]),
      ),
      stage(
        "archive",
        "feature",
        { kind: "slash", name: "/opsx:archive" },
        [],
        transition(["contracts_pass", "tasks_done"], "implemented"),
        transition([]),
      ),
    ],
    notFeatures: ["archive"],
    context: [],
    specsInclude: ["openspec/changes/**/*.spec.md"],
    layout: "free",
  },
  "spec-kit": {
    presetVersion: "spec-kit-1",
    featureDir: "specs/{feature}",
    skillsDir: ".claude/skills",
    stages: [
      stage(
        "specify",
        "feature",
        { kind: "slash", name: "/speckit.specify" },
        ["{feature_dir}/spec.md"],
        transition([]),
        transition(["artifacts", "specs_valid"]),
      ),
      stage(
        "plan",
        "feature",
        { kind: "slash", name: "/speckit.plan" },
        ["{feature_dir}/plan.md"],
        transition([]),
        transition(["artifacts", "deps_known"], "ready"),
      ),
      stage(
        "tasks",
        "feature",
        { kind: "slash", name: "/speckit.tasks" },
        ["{feature_dir}/tasks.md"],
        transition([]),
        transition(["artifacts"]),
      ),
      stage(
        "implement",
        "feature",
        { kind: "slash", name: "/speckit.implement" },
        [],
        transition(["deps_ready"], "in-progress"),
        transition(["contracts_pass", "tasks_done"], "implemented"),
      ),
    ],
    notFeatures: [],
    context: [".specify/memory/constitution.md"],
    specsInclude: ["specs/*/*.spec.md"],
    layout: "feature-folders",
  },
};

/** The `sdd-*` skills of the custom preset's example (plan §D17.2). */
export const SDD_SKILLS = ["sdd-spec", "sdd-plan", "sdd-task", "sdd-close"] as const;

/** `specs.include` for machine specs directly in each feature folder. */
const includeFor = (featureDir: string): string[] => [
  `${featureDir.replaceAll("{feature}", "*").replace(/\/+$/, "")}/*.spec.md`,
];

/** The profile in effect for a validated `workflow:` section. */
export function resolveWorkflow(input: WorkflowInput): WorkflowProfile {
  const base: Preset =
    input.preset === "custom"
      ? {
          featureDir: "docs/spec/{feature}",
          skillsDir: ".claude/skills",
          stages: catspecStages({
            spec: { kind: "skill", name: "sdd-spec" },
            plan: { kind: "skill", name: "sdd-plan" },
            task: { kind: "skill", name: "sdd-task" },
            close: { kind: "skill", name: "sdd-close" },
          }),
          notFeatures: [],
          context: [],
          specsInclude: ["docs/spec/*/*.spec.md"],
          layout: "feature-folders",
        }
      : PRESET_PROFILES[input.preset];
  const featureDir = (input.feature_dir ?? base.featureDir).replace(/\/+$/, "");
  const stages =
    input.stages?.map((s) =>
      stage(
        s.id,
        s.per,
        driverOf(s.driver),
        s.produces,
        transition(s.start.gates, s.start.status),
        transition(s.finish.gates, s.finish.status),
      ),
    ) ?? base.stages;
  return {
    preset: input.preset,
    ...(base.presetVersion ? { presetVersion: base.presetVersion } : {}),
    allowCommands: input.allow_commands,
    enforceInHook: input.enforce_in_hook,
    featureDir,
    skillsDir: (input.skills_dir ?? base.skillsDir).replace(/\/+$/, ""),
    stages,
    notFeatures: base.notFeatures,
    context: base.context,
    specsInclude: featureDir === base.featureDir ? base.specsInclude : includeFor(featureDir),
    layout: base.layout,
  };
}
