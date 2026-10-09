/**
 * Turns zod validation issues into messages that name the YAML key, the value found and the
 * allowed values, and finds the YAML node each issue is about, so diagnostics point to the exact
 * line (plan §D5, PBIs `config-loader` and `spec-schema`).
 */
import { isMap, isScalar, isSeq, type Document, type Node } from "yaml";
import type * as z from "zod";

import type { PatchPath } from "./diagnostics.js";
import { didYouMean, listOf } from "./util.js";

export interface SchemaIssue {
  /** Full path of the value (or, with `atKey`, of the key) the issue is about. */
  path: PatchPath;
  /** Point at the key node instead of its value (unknown keys). */
  atKey: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
  /** "Did you mean" candidates. */
  suggestions: string[];
}

/** Formats a path as `bindings[0].kind`. */
export function formatPath(path: PatchPath): string {
  let out = "";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : out ? `.${segment}` : segment;
  }
  return out;
}

/** Describes a YAML value for a message: `"klass"`, `12`, `a list`, `a map`, `nothing`. */
export function describeValue(value: unknown): string {
  if (value === undefined || value === null) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a map";
  return JSON.stringify(value);
}

type AnySchema = z.core.$ZodType;

/** Unwraps optional / default / pipe wrappers around a schema. */
function unwrap(schema: AnySchema): AnySchema {
  let current = schema;
  for (;;) {
    const def = current._zod.def as { type: string; innerType?: AnySchema; in?: AnySchema };
    if (def.innerType) current = def.innerType;
    else if (def.type === "pipe" && def.in) current = def.in;
    else return current;
  }
}

/** The keys an object schema at `path` accepts (for unions: the keys of every object option). */
export function objectKeysAt(schema: AnySchema, path: PatchPath): string[] {
  let candidates: AnySchema[] = [schema];
  for (const segment of path) {
    const next: AnySchema[] = [];
    for (const candidate of candidates.flatMap(expandUnion)) {
      const def = candidate._zod.def as {
        type: string;
        shape?: Record<string, AnySchema>;
        element?: AnySchema;
        catchall?: AnySchema;
      };
      if (def.type === "object" && typeof segment === "string") {
        const field = def.shape?.[segment] ?? def.catchall;
        if (field) next.push(field);
      } else if (def.type === "array" && typeof segment === "number" && def.element) {
        next.push(def.element);
      } else if (def.type === "record" && typeof segment === "string") {
        const value = (def as { valueType?: AnySchema }).valueType;
        if (value) next.push(value);
      }
    }
    candidates = next;
  }
  const keys = candidates
    .flatMap(expandUnion)
    .flatMap((c) => Object.keys((c._zod.def as { shape?: object }).shape ?? {}));
  return [...new Set(keys)];
}

function expandUnion(schema: AnySchema): AnySchema[] {
  const inner = unwrap(schema);
  const def = inner._zod.def as { type: string; options?: AnySchema[] };
  return def.type === "union" && def.options ? def.options.flatMap(expandUnion) : [inner];
}

/** The plain value at `path` in a YAML document, or undefined. */
export function valueAt(doc: Document, path: PatchPath): unknown {
  const node = doc.getIn(path, true) as Node | undefined | null;
  if (node === undefined || node === null) return undefined;
  return isScalar(node) ? node.value : (node.toJSON() as unknown);
}

/**
 * The source range `[start, end)` of the node at `path` in `doc` (the key node with `atKey`). When
 * the path doesn't exist, the range of its closest existing ancestor; undefined for the root of
 * an empty document.
 */
export function locate(
  doc: Document,
  path: PatchPath,
  atKey = false,
): { start: number; end: number } | undefined {
  let node = doc.contents;
  let found: [number, number, number] | undefined = node?.range ?? undefined;
  for (const [index, segment] of path.entries()) {
    const last = index === path.length - 1;
    if (isMap(node)) {
      const pair = node.items.find(
        (p) => isScalar(p.key) && String(p.key.value) === String(segment),
      );
      if (!pair || !isScalar(pair.key)) break;
      const keyRange = pair.key.range ?? found;
      if ((last && atKey) || pair.value === null || !(pair.value as Node | undefined)?.range) {
        found = keyRange;
        if (last && atKey) break;
        node = null;
        continue;
      }
      node = pair.value as Node;
      found = node.range ?? found;
    } else if (isSeq(node) && typeof segment === "number") {
      const item = node.items[segment] as Node | null | undefined;
      if (!item?.range) break;
      node = item;
      found = item.range;
    } else {
      break;
    }
  }
  return found ? { start: found[0], end: found[1] } : undefined;
}

/**
 * Converts zod issues for the value at `basePath` (validated by `schema`) into messages. `doc`
 * gives the values that were found; `schema` the keys that are allowed.
 */
export function schemaIssues(
  issues: readonly z.core.$ZodIssue[],
  doc: Document,
  schema: AnySchema,
  basePath: PatchPath = [],
): SchemaIssue[] {
  const out: SchemaIssue[] = [];
  for (const issue of issues) {
    const path = [...basePath, ...(issue.path as PatchPath)];
    const where = formatPath(path);
    const prefix = where ? `${where}: ` : "";
    const actual = valueAt(doc, path);

    switch (issue.code) {
      case "invalid_type": {
        if (actual === undefined && path.length > 0) {
          const parent = path.slice(0, -1);
          const key = String(path[path.length - 1]);
          const owner = formatPath(parent);
          out.push({
            path: parent,
            atKey: false,
            message: `${owner ? `${owner}: ` : ""}missing required key "${key}"`,
            expected: key,
            suggestions: [],
          });
        } else {
          out.push({
            path,
            atKey: false,
            message: `${prefix}expected ${article(issue.expected)}, found ${describeValue(actual)}`,
            expected: issue.expected,
            actual,
            suggestions: [],
          });
        }
        break;
      }
      case "invalid_value": {
        const values = issue.values.map((v) => (typeof v === "string" ? v : String(v)));
        out.push({
          path,
          atKey: false,
          message: `${prefix}invalid value ${describeValue(actual)}; allowed: ${listOf(values)}`,
          expected: issue.values,
          actual,
          suggestions: typeof actual === "string" ? didYouMean(actual, values) : [],
        });
        break;
      }
      case "unrecognized_keys": {
        const allowed = objectKeysAt(schema, path.slice(basePath.length)).filter(
          (k) => !issue.keys.includes(k),
        );
        for (const key of issue.keys) {
          out.push({
            path: [...path, key],
            atKey: true,
            message:
              `unknown key "${key}"${where ? ` in ${where}` : ""}` +
              (allowed.length > 0 ? `; allowed: ${listOf(allowed)}` : ""),
            expected: allowed,
            actual: key,
            suggestions: didYouMean(key, allowed),
          });
        }
        break;
      }
      case "invalid_union": {
        const discriminator = issue as typeof issue & { note?: string; options?: unknown[] };
        if (discriminator.note === "No matching discriminator" && discriminator.options) {
          const values = discriminator.options.map(String);
          out.push({
            path,
            atKey: false,
            message:
              actual === undefined
                ? `${formatPath(path.slice(0, -1))}: missing required key "${String(path.at(-1))}"; allowed values: ${listOf(values)}`
                : `${prefix}invalid value ${describeValue(actual)}; allowed: ${listOf(values)}`,
            expected: values,
            actual,
            suggestions: typeof actual === "string" ? didYouMean(actual, values) : [],
          });
          break;
        }
        // Report the branch that matched the value's type; if none did, name the accepted types.
        const branch = issue.errors.find(
          (errors) => !errors.some((e) => e.code === "invalid_type" && e.path.length === 0),
        );
        if (branch) {
          out.push(...schemaIssues(branch, doc, schema, path));
        } else {
          const types = issue.errors.flatMap((errors) =>
            errors.flatMap((e) => (e.code === "invalid_type" ? [article(e.expected)] : [])),
          );
          out.push({
            path,
            atKey: false,
            message: `${prefix}expected ${[...new Set(types)].join(" or ")}, found ${describeValue(actual)}`,
            expected: types,
            actual,
            suggestions: [],
          });
        }
        break;
      }
      case "too_small":
      case "too_big": {
        const limit = issue.code === "too_small" ? issue.minimum : issue.maximum;
        const word = issue.code === "too_small" ? "at least" : "at most";
        const what =
          issue.origin === "string" && issue.code === "too_small" && Number(limit) === 1
            ? "must not be empty"
            : issue.origin === "array"
              ? `must have ${word} ${String(limit)} item(s)`
              : issue.origin === "string"
                ? `must have ${word} ${String(limit)} character(s)`
                : `must be ${word} ${String(limit)}`;
        out.push({ path, atKey: false, message: `${prefix}${what}`, actual, suggestions: [] });
        break;
      }
      default: {
        // invalid_format and custom issues carry the schema's own message.
        const message = issue.message.startsWith("Invalid")
          ? `invalid value ${describeValue(actual)}`
          : issue.message;
        out.push({ path, atKey: false, message: `${prefix}${message}`, actual, suggestions: [] });
      }
    }
  }
  return out;
}

const article = (type: string): string =>
  type === "array"
    ? "a list"
    : type === "object"
      ? "a map"
      : /^[aeiou]/.test(type)
        ? `an ${type}`
        : `a ${type}`;
