/**
 * Schema of the spec frontmatter (plan §D5.2, §D5.3, §D6.1–6.3, §D6.5), PBI `spec-schema`.
 * The zod schemas validate; the JSON Schema exported from them documents the format.
 */
import * as z from "zod";

export const SPEC_TYPES = ["feature", "component", "contract", "architecture", "adr"] as const;
export const SPEC_STATUSES = [
  "draft",
  "ready",
  "in-progress",
  "implemented",
  "deprecated",
] as const;
export const BINDING_KINDS = [
  "class",
  "interface",
  "struct",
  "enum",
  "record",
  "function",
  "method",
  "type",
  "module",
] as const;
export const MEMBER_KINDS = ["method", "property", "field", "event", "constructor"] as const;
export const MODIFIERS = [
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "async",
  "abstract",
  "override",
  "readonly",
] as const;
export const RULE_CLASSES = ["structural", "query", "test", "manual"] as const;
/** The structural rule catalogue (plan §D6.2): a structural rule uses exactly one of these keys. */
export const STRUCTURAL_KINDS = [
  "forbid_call",
  "require_call",
  "forbid_import",
  "allow_import_only",
  "naming",
  "must_not_exist",
] as const;

export type SpecType = (typeof SPEC_TYPES)[number];
export type SpecStatus = (typeof SPEC_STATUSES)[number];
export type BindingKind = (typeof BINDING_KINDS)[number];
export type MemberKind = (typeof MEMBER_KINDS)[number];
export type Modifier = (typeof MODIFIERS)[number];
export type RuleClass = (typeof RULE_CLASSES)[number];

export const SPEC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const specId = z.string().regex(SPEC_ID_PATTERN, {
  error:
    "must be 2–64 characters of lowercase letters, digits and '-', starting with a letter or digit",
});
const text = z.string().min(1);
const textList = z.array(text);
/** A string or a list of strings; always a list in the model. */
const oneOrMany = z
  .union([text, textList])
  .transform((value): string[] => (typeof value === "string" ? [value] : value));

export const MemberSchema = z.strictObject({
  name: text,
  kind: z.enum(MEMBER_KINDS).optional(),
  params: textList.optional().describe('Parameter types, positional; "*" matches any type.'),
  returns: text.optional(),
  modifiers: z.array(z.enum(MODIFIERS)).optional(),
  attributes: textList.optional(),
  optional: z.boolean().default(false),
});

/** A member, or its name as shorthand for a name-only member of any kind. */
export const MemberEntrySchema = z.union([text, MemberSchema]);

const ConstructorSchema = z.strictObject({ requires: textList });
/**
 * `constructor` is also the name of a property every JavaScript object inherits, which zod reads
 * when the key is missing; that inherited function means "not set".
 */
const constructorField = z.preprocess(
  (value) => (typeof value === "function" ? undefined : value),
  ConstructorSchema.optional(),
);

export const BindingSchema = z.strictObject({
  id: text.optional().describe("Local id; defaults to the last segment of `symbol`."),
  symbol: text.describe("Qualified name, matched by suffix: Namespace.Type or path#Name."),
  kind: z.enum(BINDING_KINDS).optional(),
  lang: text.optional(),
  file: oneOrMany.optional().describe("Hint: a path, a glob, or a list of them."),
  implements: textList.optional(),
  extends: text.optional(),
  attributes: textList.optional(),
  constructor: constructorField,
  members: z.array(MemberEntrySchema).optional(),
  exported: z.boolean().optional(),
});

const ruleCommon = {
  id: text,
  message: text.optional(),
  adr: z
    .string()
    .regex(/^ADR-\d+$/, { error: "must be an ADR id such as ADR-001" })
    .optional(),
  paths: textList.optional(),
};

const importRule = z.strictObject({ from: oneOrMany, to: oneOrMany });

export const StructuralRuleSchema = z
  .strictObject({
    ...ruleCommon,
    class: z.literal("structural"),
    within: text.optional().describe("A binding id, or binding.member."),
    forbid_call: text.optional(),
    require_call: text.optional(),
    forbid_import: importRule.optional(),
    allow_import_only: importRule.optional(),
    naming: z
      .strictObject({
        kind: z.enum(BINDING_KINDS).optional(),
        name: text,
        implements: textList.optional(),
        extends: text.optional(),
        attributes: textList.optional(),
        in_path: oneOrMany.optional(),
      })
      .optional(),
    must_not_exist: z
      .strictObject({ symbol: text, kind: z.enum(BINDING_KINDS).optional() })
      .optional(),
  })
  .superRefine((rule, ctx) => {
    const used = STRUCTURAL_KINDS.filter((key) => rule[key] !== undefined);
    if (used.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          used.length === 0
            ? `a structural rule needs one of ${STRUCTURAL_KINDS.join(", ")}`
            : `a structural rule uses exactly one of ${STRUCTURAL_KINDS.join(", ")}; found ${used.join(", ")}`,
      });
    }
  });

export const QueryRuleSchema = z.strictObject({
  ...ruleCommon,
  class: z.literal("query"),
  lang: text,
  query: text.describe("A Tree-sitter query."),
  expect: z.enum(["absent", "present"]).default("absent"),
  within: text.optional(),
});

export const TestRuleSchema = z.strictObject({
  ...ruleCommon,
  class: z.literal("test"),
  test: z.strictObject({ symbol: text, lang: text.optional() }),
});

export const ManualRuleSchema = z.strictObject({
  ...ruleCommon,
  class: z.literal("manual"),
  text,
});

/** Rule schemas by class; `class` selects the schema. */
export const RULE_SCHEMAS = {
  structural: StructuralRuleSchema,
  query: QueryRuleSchema,
  test: TestRuleSchema,
  manual: ManualRuleSchema,
} as const;

export const RuleSchema = z.discriminatedUnion("class", [
  StructuralRuleSchema,
  QueryRuleSchema,
  TestRuleSchema,
  ManualRuleSchema,
]);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "must be a date: YYYY-MM-DD" })
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number) as [number, number, number];
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    },
    { error: "must be a date that exists" },
  );

export const WaiverSchema = z.strictObject({
  rule: text,
  reason: text,
  until: isoDate.optional(),
  paths: textList.optional(),
});

const reference = z.union([text, z.number()]);

/** The frontmatter. Unknown top-level keys are allowed (warning CS0102). */
export const SpecFrontmatterSchema = z
  .looseObject({
    catspec: z.literal(1).describe("Spec format version."),
    id: specId.describe("Unique across the repository."),
    title: text.optional().describe("Defaults to the first # heading."),
    type: z.enum(SPEC_TYPES).describe("architecture makes the rules global."),
    status: z.enum(SPEC_STATUSES),
    depends_on: z.array(text).optional().describe("Ids of the specs this one depends on."),
    owners: textList.optional(),
    scope: textList.optional().describe("Extra paths (globs) that belong to this spec."),
    bindings: z.array(BindingSchema).optional(),
    rules: z.array(RuleSchema).optional(),
    infrastructure: z.array(z.record(z.string(), z.unknown())).optional(),
    waivers: z.array(WaiverSchema).optional(),
    links: z
      .strictObject({
        pr: reference.optional(),
        issue: reference.optional(),
        commit: text.optional(),
      })
      .optional(),
  })
  .describe("Frontmatter of a CatSpec spec file (*.spec.md).");

export const FRONTMATTER_KEYS = Object.keys(SpecFrontmatterSchema.shape);

export type RuleInput = z.output<typeof RuleSchema>;
export type Rule = RuleInput & {
  /** Position in the `rules` list. */
  index: number;
};
export type StructuralRule = z.output<typeof StructuralRuleSchema> & { index: number };
export type Waiver = z.output<typeof WaiverSchema> & { index: number };
export type Links = NonNullable<z.output<typeof SpecFrontmatterSchema>["links"]>;

export interface Member {
  name: string;
  /** Undefined means any kind. */
  kind?: MemberKind;
  params?: string[];
  returns?: string;
  modifiers?: Modifier[];
  attributes?: string[];
  optional: boolean;
}

export interface Binding {
  /** Local id; the last segment of `symbol` unless set. */
  id: string;
  symbol: string;
  kind?: BindingKind;
  lang?: string;
  /** Location hints (paths or globs). */
  file?: string[];
  implements?: string[];
  extends?: string;
  attributes?: string[];
  /** `constructor.requires`: types a constructor must take. */
  constructorRequires?: string[];
  members: Member[];
  exported?: boolean;
  /** Position in the `bindings` list. */
  index: number;
}

/** Normalises a parsed binding: default id, shorthand members, `constructor.requires`. */
export function normalizeBinding(input: z.output<typeof BindingSchema>, index: number): Binding {
  const { id, constructor, members, ...rest } = input;
  const binding: Binding = {
    ...stripUndefined(rest),
    id: id ?? defaultBindingId(input.symbol),
    members: (members ?? []).map((m) =>
      typeof m === "string" ? { name: m, optional: false } : stripUndefined(m),
    ),
    index,
  };
  if (constructor) binding.constructorRequires = constructor.requires;
  return binding;
}

/** `Identity.Handlers.UserUpdatedHandler` → `UserUpdatedHandler`; `src/a#Name.member` → `member`. */
export const defaultBindingId = (symbol: string): string =>
  symbol.split("#").pop()!.split(".").pop() || symbol;

/** `T` without explicit `undefined` values: optional keys stay optional but can't be undefined. */
export type DropUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

/** Removes keys whose value is undefined (for `exactOptionalPropertyTypes`). */
export function stripUndefined<T extends object>(value: T): DropUndefined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as DropUndefined<T>;
}

/** JSON Schema of the spec frontmatter. */
export const specJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(SpecFrontmatterSchema, {
    io: "input",
    target: "draft-2020-12",
    override: (ctx) => {
      // The preprocess step of `constructor` has no JSON Schema; describe the value it accepts.
      if (ctx.zodSchema !== constructorField) return;
      Object.assign(ctx.jsonSchema, z.toJSONSchema(ConstructorSchema, { io: "input" }));
      delete ctx.jsonSchema.$schema;
    },
  });
