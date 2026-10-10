/**
 * Reads one spec file into the normalised model (PBI `spec-schema`): validates the frontmatter
 * field by field, so one mistake doesn't hide the others, maps every problem to its line, expands
 * shorthand forms, and checks the body's references (PBI `body-parser`).
 */
import { isMap } from "yaml";
import type * as z from "zod";

import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type Location,
  type PatchPath,
} from "./diagnostics.js";
import { frontmatterLocation, parseSpecSource, type SpecSource } from "./frontmatter.js";
import { describeValue, locate, schemaIssues, valueAt, type SchemaIssue } from "./schema-issues.js";
import { parseBody, type SpecBody } from "./spec-body.js";
import {
  BindingSchema,
  defaultBindingId,
  FRONTMATTER_KEYS,
  RULE_CLASSES,
  RULE_SCHEMAS,
  SpecFrontmatterSchema,
  normalizeBinding,
  stripUndefined,
  type Binding,
  type Links,
  type Rule,
  type SpecStatus,
  type SpecType,
  type Waiver,
} from "./spec-schema.js";
import { didYouMean, listOf } from "./util.js";

export interface Spec {
  id: string;
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  title: string;
  type: SpecType;
  status: SpecStatus;
  dependsOn: string[];
  owners: string[];
  scope: string[];
  bindings: Binding[];
  rules: Rule[];
  infrastructure: Record<string, unknown>[];
  waivers: Waiver[];
  links?: Links;
  /** Unknown top-level keys and their values (CS0102). */
  extra: Record<string, unknown>;
  /** No bindings and no rules, only `depends_on` (plan §D17.1). */
  aggregate: boolean;
  /**
   * False when the frontmatter has errors (CS0101, CS0103). The model then holds what could be
   * read; a missing `type` or `status` reads as `feature` / `draft`.
   */
  valid: boolean;
  body: SpecBody;
  source: SpecSource;
}

export interface ReadSpecOptions {
  /** `enforcement.unenforced_prose`: `off` skips CS0111. Default `warn`. */
  unenforcedProse?: "off" | "warn";
}

/** Location of a frontmatter path (`["bindings", 0, "kind"]`) in the spec file. */
export function specLocation(source: SpecSource, path: PatchPath, atKey = false): Location {
  const range = locate(source.document, path, atKey);
  return range
    ? frontmatterLocation(source, range.start, range.end)
    : { file: source.file, line: 1, column: 1 };
}

/**
 * Parses and validates a spec file. Returns the spec whenever its `id` can be read, together with
 * every diagnostic found (CS0101, CS0102, CS0103, CS0110, CS0111).
 */
export function readSpec(
  text: string,
  file: string,
  options: ReadSpecOptions = {},
): { spec?: Spec; diagnostics: Diagnostic[] } {
  const parsed = parseSpecSource(text, file);
  const diagnostics = [...parsed.diagnostics];
  const source = parsed.source;
  if (!source || diagnostics.length > 0) return { diagnostics };

  const doc = source.document;
  const report = (
    code: DiagnosticCode,
    path: PatchPath,
    message: string,
    atKey = false,
    extra = {},
  ) =>
    diagnostics.push(
      createDiagnostic(code, {
        specLocation: specLocation(source, path, atKey),
        message,
        ...extra,
      }),
    );
  const reportIssues = (issues: SchemaIssue[]): void => {
    for (const issue of issues) {
      report("CS0101", issue.path, issue.message, issue.atKey, issueDetails(issue));
    }
  };

  let root: unknown;
  try {
    root = toPlain(doc.toJS());
  } catch (error) {
    // For example "Excessive alias count": report the file instead of failing the whole check.
    const reason = error instanceof Error ? error.message : String(error);
    report("CS0101", [], `${file}: the frontmatter can't be read: ${reason}`);
    return { diagnostics };
  }
  if (!isMap(doc.contents) || !root || typeof root !== "object" || Array.isArray(root)) {
    report("CS0101", [], `${file}: the frontmatter must be a YAML map of keys and values`);
    return { diagnostics };
  }
  const data = root as Record<string, unknown>;

  // Unknown top-level keys only warn, so teams can keep their own metadata (CS0102).
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (FRONTMATTER_KEYS.includes(key)) continue;
    extra[key] = data[key];
    const close = didYouMean(key, FRONTMATTER_KEYS);
    report("CS0102", [key], `unknown key "${key}" is ignored`, true, {
      actual: key,
      ...(close.length > 0
        ? { suggestions: close.map((c) => ({ message: `did you mean "${c}"?` })) }
        : {}),
    });
  }

  // Scalar and list fields, one by one.
  const shape = SpecFrontmatterSchema.shape;
  const field = <S extends z.ZodType>(schema: S, key: string): z.output<S> | undefined => {
    const result = schema.safeParse(data[key]);
    if (result.success) return result.data;
    reportIssues(schemaIssues(result.error.issues, doc, schema, [key]));
    return undefined;
  };
  const errorsBefore = (): number => diagnostics.filter((d) => d.severity === "error").length;
  const initialErrors = errorsBefore();

  field(shape.catspec, "catspec");
  const id = field(shape.id, "id");
  const title = field(shape.title, "title");
  const type = field(shape.type, "type");
  const status = field(shape.status, "status");
  const dependsOn = field(shape.depends_on, "depends_on") ?? [];
  const owners = field(shape.owners, "owners") ?? [];
  const scope = field(shape.scope, "scope") ?? [];
  const infrastructure = field(shape.infrastructure, "infrastructure") ?? [];
  const links = field(shape.links, "links");

  // Lists of objects, element by element, so valid elements are kept.
  const bindings: Binding[] = [];
  forEachItem(data.bindings, "bindings", (item, index) => {
    const result = BindingSchema.safeParse(item);
    if (result.success) bindings.push(normalizeBinding(result.data, index));
    else reportIssues(schemaIssues(result.error.issues, doc, BindingSchema, ["bindings", index]));
  });

  const rules: Rule[] = [];
  forEachItem(data.rules, "rules", (item, index) => {
    const cls = (item as { class?: unknown }).class;
    if (!RULE_CLASSES.includes(cls as never)) {
      const where = ["rules", index, "class"];
      const message =
        cls === undefined
          ? `rules[${index}]: missing required key "class"; allowed values: ${listOf(RULE_CLASSES)}`
          : `rules[${index}].class: invalid value ${JSON.stringify(cls)}; allowed: ${listOf(RULE_CLASSES)}`;
      const close = typeof cls === "string" ? didYouMean(cls, RULE_CLASSES) : [];
      report("CS0101", cls === undefined ? ["rules", index] : where, message, false, {
        expected: [...RULE_CLASSES],
        ...(cls === undefined ? {} : { actual: cls }),
        ...(close.length > 0
          ? { suggestions: close.map((c) => ({ message: `did you mean "${c}"?` })) }
          : {}),
      });
      return;
    }
    const schema = RULE_SCHEMAS[cls as keyof typeof RULE_SCHEMAS];
    const result = schema.safeParse(item);
    if (result.success) rules.push({ ...stripUndefined(result.data), index });
    else reportIssues(schemaIssues(result.error.issues, doc, schema, ["rules", index]));
  });

  const waivers: Waiver[] = [];
  forEachItem(data.waivers, "waivers", (item, index) => {
    const schema = shape.waivers.unwrap().element;
    const result = schema.safeParse(item);
    if (result.success) waivers.push({ ...stripUndefined(result.data), index });
    else reportIssues(schemaIssues(result.error.issues, doc, schema, ["waivers", index]));
  });

  function forEachItem(value: unknown, key: string, fn: (item: unknown, index: number) => void) {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      report("CS0101", [key], `${key}: expected a list, found ${describeValue(value)}`);
      return;
    }
    value.forEach((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        report(
          "CS0101",
          [key, index],
          `${key}[${index}]: expected a map, found ${describeValue(item)}`,
        );
      } else {
        fn(item, index);
      }
    });
  }

  // Local ids are unique, and rules point at existing bindings.
  checkUnique(
    bindings.map((b) => ({
      id: b.id,
      path:
        valueAt(doc, ["bindings", b.index, "id"]) === undefined
          ? ["bindings", b.index, "symbol"]
          : ["bindings", b.index, "id"],
    })),
    "binding",
  );
  checkUnique(
    rules.map((r) => ({ id: r.id, path: ["rules", r.index, "id"] })),
    "rule",
  );
  const bindingIds = bindings.map((b) => b.id);
  const writtenBindingIds = rawBindingIds(data.bindings);
  for (const rule of rules) {
    if (!("within" in rule) || rule.within === undefined) continue;
    if (resolveBindingRef(rule.within, writtenBindingIds) !== undefined) continue;
    const target = unknownBindingName(rule.within, writtenBindingIds);
    const close = didYouMean(target, writtenBindingIds);
    report(
      "CS0101",
      ["rules", rule.index, "within"],
      `rule "${rule.id}": within names an unknown binding "${target}"` +
        (writtenBindingIds.length > 0
          ? `; bindings: ${listOf(writtenBindingIds)}`
          : "; the spec has no bindings"),
      false,
      {
        ruleId: rule.id,
        expected: writtenBindingIds,
        actual: target,
        ...(close.length > 0
          ? { suggestions: close.map((c) => ({ message: `did you mean "${c}"?` })) }
          : {}),
      },
    );
  }

  function checkUnique(items: { id: string; path: PatchPath }[], what: string): void {
    const seen = new Map<string, PatchPath>();
    for (const item of items) {
      const first = seen.get(item.id);
      if (!first) {
        seen.set(item.id, item.path);
        continue;
      }
      const firstLine = specLocation(source!, first).line;
      report(
        "CS0103",
        item.path,
        `duplicate ${what} id "${item.id}" (first used on line ${firstLine})`,
      );
    }
  }

  const valid = errorsBefore() === initialErrors;

  // Body: references must name existing rules and bindings; contract bullets need one.
  const body = parseBody(source.body.text, source.body.line);
  const known = { rule: rules.map((r) => r.id), binding: bindingIds };
  const knownRaw = { rule: rawIds(data.rules, "id"), binding: writtenBindingIds };
  for (const ref of body.references) {
    const found =
      ref.kind === "binding"
        ? resolveBindingRef(ref.id, knownRaw.binding)
        : knownRaw.rule.find((id) => id === ref.id);
    if (found !== undefined) continue;
    const target = ref.kind === "binding" ? unknownBindingName(ref.id, knownRaw.binding) : ref.id;
    const close = didYouMean(target, known[ref.kind]);
    diagnostics.push(
      createDiagnostic("CS0110", {
        specLocation: { file, line: ref.line, column: ref.column },
        message: `[${ref.kind}:${ref.id}] references an unknown ${ref.kind} "${target}"`,
        expected: known[ref.kind],
        actual: target,
        ...(ref.kind === "rule" ? { ruleId: target } : { bindingId: target }),
        ...(close.length > 0
          ? { suggestions: close.map((c) => ({ message: `did you mean [${ref.kind}:${c}]?` })) }
          : {}),
      }),
    );
  }
  if ((options.unenforcedProse ?? "warn") === "warn") {
    for (const bullet of body.contracts) {
      if (bullet.references.length > 0) continue;
      diagnostics.push(
        createDiagnostic("CS0111", {
          specLocation: { file, line: bullet.line, column: bullet.column },
          message: `unenforced prose invariant: "${truncate(bullet.text)}" has no [rule:<id>] or [binding:<id>] reference`,
          suggestions: [
            {
              message:
                "add a rule that checks it (a manual rule if it can't be checked from code) and reference it",
            },
          ],
        }),
      );
    }
  }

  if (id === undefined) return { diagnostics };

  const spec: Spec = {
    id,
    file,
    title: title ?? body.title ?? id,
    type: type ?? "feature",
    status: status ?? "draft",
    dependsOn,
    owners,
    scope,
    bindings,
    rules,
    infrastructure,
    waivers,
    extra,
    aggregate: dependsOn.length > 0 && bindings.length === 0 && rules.length === 0 && valid,
    valid,
    body,
    source,
  };
  if (links) spec.links = stripUndefined(links);
  return { spec, diagnostics: withSpec(diagnostics, id) };
}

function withSpec(diagnostics: Diagnostic[], id: string): Diagnostic[] {
  return diagnostics.map((d) => ({ ...d, spec: id }));
}

function issueDetails(issue: SchemaIssue): Partial<Diagnostic> {
  const details: Partial<Diagnostic> = {};
  if (issue.expected !== undefined) details.expected = issue.expected;
  if (issue.actual !== undefined) details.actual = issue.actual;
  if (issue.suggestions.length > 0) {
    details.suggestions = issue.suggestions.map((s) => ({ message: `did you mean "${s}"?` }));
  }
  return details;
}

/** Ids as written, valid or not, so a reference isn't reported twice for one broken rule. */
function rawIds(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    const value =
      item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? [value] : [];
  });
}

function rawBindingIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { id, symbol } = item as Record<string, unknown>;
    if (typeof id === "string") return [id];
    if (typeof symbol === "string") return [defaultBindingId(symbol)];
    return [];
  });
}

/**
 * The binding a reference names: `handler` or `handler.Member`. Binding ids may contain dots, so
 * the whole reference is tried first, then the longest binding id followed by `.`.
 */
function resolveBindingRef(ref: string, ids: readonly string[]): string | undefined {
  if (ids.includes(ref)) return ref;
  return ids.filter((id) => ref.startsWith(`${id}.`)).sort((a, b) => b.length - a.length)[0];
}

/** The name to report for an unresolved binding reference: the part before a member, if any. */
const unknownBindingName = (ref: string, ids: readonly string[]): string =>
  ref.includes(".") && !ids.some((id) => id.includes(".")) ? ref.split(".")[0]! : ref;

const truncate = (text: string, max = 60): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Copies a YAML value into objects without a prototype, so keys such as `constructor` or
 * `toString` are only seen when the spec sets them.
 */
function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) out[key] = toPlain(item);
    return out;
  }
  return value;
}
