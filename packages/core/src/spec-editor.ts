/**
 * Edits spec frontmatter without destroying its formatting (plan §D11.6, ADR-008), PBI
 * `spec-cst-editor`.
 *
 * Each operation is applied twice: with the `yaml` Document API (`setIn` / `deleteIn`), which
 * defines what the result must mean, and as a minimal splice of the source text at the node's
 * range, which keeps comments, key order, quoting and blank lines everywhere else. The spliced
 * text is parsed again and must equal the Document result; otherwise the edit is refused rather
 * than written. The Markdown body is never touched.
 */
import { isDeepStrictEqual } from "node:util";

import {
  Document,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  visit,
  type Node,
  type Pair,
  type ToStringOptions,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

import type { PatchOp, PatchPath } from "./diagnostics.js";
import { withFrontmatter, type SpecSource } from "./frontmatter.js";
import { formatPath } from "./schema-issues.js";

/**
 * `location` edits only say where the code is (`bindings[i].symbol`, `bindings[i].file`); auto-heal
 * and agents may apply them. Everything else changes the contract and needs a human (ADR-008).
 */
export type EditClass = "location" | "contract";

export function classifyOp(op: PatchOp, source: SpecSource): EditClass {
  const [list, index, key, item] = op.path;
  if (list !== "bindings" || typeof index !== "number") return "contract";
  // Only an existing binding can be moved; anything that adds a binding changes the contract.
  const binding = source.document.getIn(["bindings", index], true) as Node | undefined;
  if (!isMap(binding)) return "contract";
  const isText = (value: unknown): boolean => typeof value === "string" && value.length > 0;

  if (key === "symbol" && op.path.length === 3) {
    return op.op === "set" && isText(op.value) && binding.has("symbol") ? "location" : "contract";
  }
  if (key === "file" && op.path.length === 3) {
    if (op.op === "delete") return "location";
    const list = Array.isArray(op.value) && op.value.length > 0 && op.value.every(isText);
    return isText(op.value) || list ? "location" : "contract";
  }
  if (key === "file" && op.path.length === 4 && typeof item === "number") {
    const files = binding.get("file", true) as Node | undefined;
    if (!isSeq(files)) return "contract";
    if (op.op === "delete") return item < files.items.length ? "location" : "contract";
    return item <= files.items.length && isText(op.value) ? "location" : "contract";
  }
  return "contract";
}

/** A patch is a location edit only when every operation is one. */
export const classifyPatch = (ops: readonly PatchOp[], source: SpecSource): EditClass =>
  ops.every((op) => classifyOp(op, source) === "location") ? "location" : "contract";

/** An edit that can't be applied without risking the file; nothing is written. */
export class SpecEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecEditError";
  }
}

/** Applies `ops` to a spec and returns the new file text. The body stays byte-for-byte the same. */
export function applyPatch(source: SpecSource, ops: readonly PatchOp[]): string {
  if (ops.length === 0) return source.text;
  return withFrontmatter(source, editYaml(source.frontmatter.text, ops, source.eol));
}

/** Applies `ops` to a YAML document's text, keeping everything the operations don't change. */
export function editYaml(text: string, ops: readonly PatchOp[], eol: "\n" | "\r\n" = "\n"): string {
  let current = text;
  for (const op of ops) {
    try {
      current = applyOp(current, op, eol);
    } catch (error) {
      if (error instanceof SpecEditError) throw error;
      // e.g. "Excessive alias count" from the yaml library: refuse instead of crashing.
      const reason = error instanceof Error ? error.message : String(error);
      throw new SpecEditError(`can't edit ${formatPath(op.path)}: ${reason}`);
    }
  }
  return current;
}

/** The plain value at `path` of a YAML document's text, or undefined. Throws `SpecEditError`. */
export function readYaml(text: string, path: PatchPath): unknown {
  let value: unknown = parseYaml(text).toJS();
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[segment];
  }
  return value;
}

function applyOp(text: string, op: PatchOp, eol: string): string {
  const doc = parseYaml(text);
  if (op.path.length === 0) throw new SpecEditError("an edit needs a non-empty path");

  const expected = doc.clone();
  const target = op.op === "set" ? normaliseSet(doc, op.path, op.value) : op;
  if (target.op === "set") expected.setIn(target.path, toNode(expected, target.value));
  else {
    if (!expected.hasIn(target.path)) {
      throw new SpecEditError(`nothing to delete at ${formatPath(target.path)}`);
    }
    expected.deleteIn(target.path);
  }

  // An edit that doesn't change the data doesn't change the text.
  if (isDeepStrictEqual(expected.toJS(), doc.toJS())) return text;

  const splice = new Splicer(text, doc, expected, eol);
  const next =
    target.op === "set" ? splice.set(target.path, target.value) : splice.delete(target.path);

  const check = parseDocument(next);
  if (check.errors.length > 0 || !isDeepStrictEqual(check.toJS(), expected.toJS())) {
    throw new SpecEditError(
      `refusing to edit ${formatPath(op.path)}: the result would not match the requested change; ` +
        "edit the spec by hand",
    );
  }
  return next;
}

function parseYaml(text: string): Document.Parsed {
  // Source tokens give the exact start of list items and keys (after anchors, tags, comments).
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    throw new SpecEditError(
      `the frontmatter has YAML errors: ${doc.errors[0]!.message.split("\n")[0]}`,
    );
  }
  return doc;
}

const toNode = (doc: Document, value: unknown): unknown =>
  value !== null && typeof value === "object" ? doc.createNode(value) : value;

/**
 * Makes sure the parent of a `set` path exists: setting `links.pr` without `links`, or under
 * `links:` with no value, becomes setting `links` to `{ pr: … }`.
 */
function normaliseSet(
  doc: Document,
  path: PatchPath,
  value: unknown,
): { op: "set"; path: PatchPath; value: unknown } {
  for (let i = 0; i < path.length - 1; i++) {
    const prefix = path.slice(0, i + 1);
    const node = doc.getIn(prefix, true) as Node | null | undefined;
    if (node === undefined || node === null || (isScalar(node) && node.value === null)) {
      let nested = value;
      for (const segment of [...path.slice(i + 1)].reverse()) {
        if (typeof segment === "number") {
          if (segment !== 0) throw new SpecEditError(`no item ${segment} at ${formatPath(path)}`);
          nested = [nested];
        } else {
          nested = { [segment]: nested };
        }
      }
      return { op: "set", path: prefix, value: nested };
    }
    if (!isCollection(node)) {
      throw new SpecEditError(`${formatPath(prefix)} is a value, not a map or list`);
    }
  }
  const parent = path.length > 1 ? (doc.getIn(path.slice(0, -1), true) as Node) : doc.contents;
  const last = path[path.length - 1]!;
  if (isSeq(parent) && (typeof last !== "number" || last > parent.items.length || last < 0)) {
    throw new SpecEditError(`${formatPath(path)}: list index out of range`);
  }
  return { op: "set", path, value };
}

/** Text splices for one operation, driven by the node ranges of the parsed document. */
class Splicer {
  private readonly indentSeq: boolean;

  constructor(
    private readonly text: string,
    private readonly doc: Document.Parsed,
    private readonly expected: Document,
    private readonly eol: string,
  ) {
    this.indentSeq = detectIndentSeq(text, doc);
  }

  set(path: PatchPath, value: unknown): string {
    const parentPath = path.slice(0, -1);
    const parent = this.nodeAt(parentPath);
    const key = path[path.length - 1]!;
    if (parent === null) return this.insertIntoEmptyRoot(key, value);
    if (!isMap(parent) && !isSeq(parent)) {
      throw new SpecEditError(`${formatPath(parentPath)} is not a map or list`);
    }

    const index = isMap(parent) ? findPair(parent, key) : (key as number);
    if (index < 0 || index >= parent.items.length) {
      return parent.flow
        ? this.flowAppend(parent, parentPath, key, value)
        : this.append(parent, key, value);
    }
    const node = isMap(parent)
      ? (parent.items[index]!.value as Node | null)
      : (parent.items[index] as Node | null);
    if (isScalar(node) && isScalarValue(value) && !isBlockScalar(node) && node.range) {
      return this.replaceScalar(node, value, parent.flow === true);
    }
    return parent.flow
      ? this.flowReplace(parent, index, key, value)
      : this.replaceItem(parent, index, key, value);
  }

  delete(path: PatchPath): string {
    const parentPath = path.slice(0, -1);
    const parent = this.nodeAt(parentPath);
    const key = path[path.length - 1]!;
    if (!isMap(parent) && !isSeq(parent)) {
      throw new SpecEditError(`${formatPath(parentPath)} is not a map or list`);
    }
    const index = isMap(parent) ? findPair(parent, key) : (key as number);
    if (parent.flow) return this.flowDelete(parent, index);

    if (parent.items.length === 1) {
      // Removing the only item: rewrite the parent as an empty collection.
      if (parentPath.length === 0) throw new SpecEditError("can't remove the last frontmatter key");
      return this.replaceInParent(parentPath);
    }

    const start = itemStart(this.text, parent, index);
    const end = itemEnd(this.text, parent, index);
    if (isLineStart(this.text, start)) {
      return this.text.slice(0, lineStart(this.text, start)) + this.text.slice(end);
    }
    // The item shares its line with the parent's indicator (`- key: value`): pull the next one up.
    const next = itemStart(this.text, parent, index + 1);
    return this.text.slice(0, start) + this.text.slice(next);
  }

  /** Rewrites the item at `path` (a key or list item of a block collection) with its expected value. */
  private replaceInParent(path: PatchPath): string {
    const parentPath = path.slice(0, -1);
    const parent = this.nodeAt(parentPath);
    if (!isMap(parent) && !isSeq(parent)) throw new SpecEditError("unexpected document shape");
    const key = path[path.length - 1]!;
    const index = isMap(parent) ? findPair(parent, key) : (key as number);
    const value = this.expectedValue(path);
    return parent.flow
      ? this.flowReplace(parent, index, key, value)
      : this.replaceItem(parent, index, key, value);
  }

  /** Replaces a scalar's text, keeping its quoting style when the new value allows it. */
  private replaceScalar(node: Scalar, value: unknown, inFlow: boolean): string {
    const [start, end] = node.range!;
    let rendered = renderScalar(value, node.type, inFlow);
    if (start === end && this.text[start - 1] === ":") rendered = ` ${rendered}`;
    return this.text.slice(0, start) + rendered + this.text.slice(end);
  }

  /** Replaces a whole pair or list item with a block rendering of its new value. */
  private replaceItem(
    parent: YAMLMap | YAMLSeq,
    index: number,
    key: string | number,
    value: unknown,
  ): string {
    const start = itemStart(this.text, parent, index);
    const end = itemEnd(this.text, parent, index);
    const column = start - lineStart(this.text, start);
    const lines = isMap(parent) ? this.render({ [String(key)]: value }) : this.render([value]);
    // A comment at the end of the item's first line (`key: []  # note`) stays on that line.
    const comment = trailingComment(this.text, start);
    if (comment && trailingComment(lines[0]!, 0) === undefined) lines[0] += comment;
    const endsWithBreak = this.text[end - 1] === "\n";
    const replacement =
      lines.map((line, i) => (i === 0 ? line : " ".repeat(column) + line)).join(this.eol) +
      (endsWithBreak ? this.eol : "");
    return this.text.slice(0, start) + replacement + this.text.slice(end);
  }

  /** Adds a new key at the end of a block map, or a new item at the end of a block list. */
  private append(parent: YAMLMap | YAMLSeq, key: string | number, value: unknown): string {
    const last = parent.items.length - 1;
    const first = itemStart(this.text, parent, 0);
    const column = first - lineStart(this.text, first);
    const at = itemEnd(this.text, parent, last);
    const lines = isMap(parent) ? this.render({ [String(key)]: value }) : this.render([value]);
    const prefix = at > 0 && this.text[at - 1] !== "\n" ? this.eol : "";
    const block = lines.map((line) => " ".repeat(column) + line).join(this.eol) + this.eol;
    return this.text.slice(0, at) + prefix + block + this.text.slice(at);
  }

  private insertIntoEmptyRoot(key: string | number, value: unknown): string {
    if (typeof key !== "string") throw new SpecEditError("the frontmatter must be a map");
    const lines = this.render({ [key]: value });
    const prefix = this.text.length > 0 && !this.text.endsWith("\n") ? this.eol : "";
    return this.text + prefix + lines.join(this.eol) + this.eol;
  }

  /** Source range of item `index` of a flow collection, without the separating comma. */
  private flowRange(parent: YAMLMap | YAMLSeq, index: number): [number, number] {
    const item = parent.items[index];
    const first = (isMap(parent) ? (item as Pair).key : item) as Node | null;
    const last = (
      isMap(parent) ? ((item as Pair).value ?? (item as Pair).key) : item
    ) as Node | null;
    if (!first?.range || !last?.range)
      throw new SpecEditError("can't locate a flow collection item");
    return [first.range[0], last.range[1]];
  }

  /** Text of one flow collection entry: `value`, or `key: value` in a map. */
  private flowEntry(parent: YAMLMap | YAMLSeq, key: string | number, value: unknown): string {
    const rendered = this.renderFlow(value);
    return isMap(parent)
      ? `${renderScalar(String(key), Scalar.PLAIN, true)}: ${rendered}`
      : rendered;
  }

  private flowReplace(
    parent: YAMLMap | YAMLSeq,
    index: number,
    key: string | number,
    value: unknown,
  ): string {
    const [start, end] = this.flowRange(parent, index);
    return this.text.slice(0, start) + this.flowEntry(parent, key, value) + this.text.slice(end);
  }

  private flowDelete(parent: YAMLMap | YAMLSeq, index: number): string {
    const count = parent.items.length;
    const [start, end] = this.flowRange(parent, index);
    if (count === 1) return this.text.slice(0, start) + this.text.slice(end);
    if (index < count - 1) {
      return this.text.slice(0, start) + this.text.slice(this.flowRange(parent, index + 1)[0]);
    }
    return this.text.slice(0, this.flowRange(parent, index - 1)[1]) + this.text.slice(end);
  }

  /**
   * Adds an entry at the end of a flow collection. An empty `[]` / `{}` under a block map or list
   * becomes a block collection instead, the way it would be written by hand.
   */
  private flowAppend(
    parent: YAMLMap | YAMLSeq,
    parentPath: PatchPath,
    key: string | number,
    value: unknown,
  ): string {
    const count = parent.items.length;
    const entry = this.flowEntry(parent, key, value);
    if (count > 0) {
      const end = this.flowRange(parent, count - 1)[1];
      return this.text.slice(0, end) + `, ${entry}` + this.text.slice(end);
    }
    if (parentPath.length > 0) {
      const grand = this.nodeAt(parentPath.slice(0, -1));
      if ((isMap(grand) || isSeq(grand)) && !grand.flow) return this.replaceInParent(parentPath);
    }
    const open = parent.range![0] + 1;
    return this.text.slice(0, open) + entry + this.text.slice(open);
  }

  /** One-line flow YAML for `value`. */
  private renderFlow(value: unknown): string {
    if (isScalarValue(value)) return renderScalar(value, Scalar.PLAIN, true);
    const doc = new Document(value);
    visit(doc, {
      Map: (_, node) => void (node.flow = true),
      Seq: (_, node) => void (node.flow = true),
    });
    const rendered = doc.toString(this.options()).trimEnd();
    if (rendered.includes("\n"))
      throw new SpecEditError("the value is too complex for a flow collection");
    return rendered;
  }

  private expectedValue(path: PatchPath): unknown {
    const node = this.expected.getIn(path, true) as Node | undefined;
    return isScalar(node) ? node.value : (node?.toJSON() as unknown);
  }

  private nodeAt(path: PatchPath): Node | null {
    return path.length === 0
      ? this.doc.contents
      : ((this.doc.getIn(path, true) as Node | undefined) ?? null);
  }

  private options(): ToStringOptions {
    return { lineWidth: 0, flowCollectionPadding: false, indentSeq: this.indentSeq };
  }

  /** Block YAML for `value`, as lines without line breaks. */
  private render(value: unknown): string[] {
    return new Document(value).toString(this.options()).replace(/\n$/, "").split("\n");
  }
}

const isScalarValue = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const isBlockScalar = (node: Scalar): boolean =>
  node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;

/** Renders a scalar in the style of the value it replaces, quoting only when needed. */
function renderScalar(value: unknown, type: Scalar["type"], inFlow: boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return "null";
  if (value.includes("\n") || type === Scalar.QUOTE_DOUBLE) return JSON.stringify(value);
  if (type === Scalar.QUOTE_SINGLE) return `'${value.replace(/'/g, "''")}'`;
  const plain = new Document(value).toString({ lineWidth: 0 }).replace(/\n$/, "");
  // Inside `[...]` or `{...}`, a plain scalar can't contain the flow indicators , [ ] { }.
  const unsafe = plain.includes("\n") || (inFlow && /[,[\]{}]/.test(plain));
  return unsafe ? JSON.stringify(value) : plain;
}

function findPair(map: YAMLMap, key: string | number): number {
  return map.items.findIndex(
    (pair: Pair) => isScalar(pair.key) && String(pair.key.value) === String(key),
  );
}

/** Offset where item `index` starts: the key of a pair, or the `-` of a list item. */
function itemStart(text: string, parent: YAMLMap | YAMLSeq, index: number): number {
  const token = parent.srcToken;
  if (token?.type === "block-seq") {
    // Every list item has a `-`; comment-only entries of the token list don't.
    const items = token.items.filter((it) => it.start.some((t) => t.type === "seq-item-ind"));
    const dash = items[index]?.start.find((t) => t.type === "seq-item-ind");
    if (dash) return dash.offset;
  } else if (token?.type === "block-map" && isMap(parent)) {
    const key = parent.items[index]?.key as Node | null | undefined;
    const item = token.items.find((it) => it.key && it.key === key?.srcToken);
    if (item?.key) {
      // An anchor, tag or `?` before the key belongs to the item.
      const prop = item.start.find((t) => !["space", "newline", "comment"].includes(t.type));
      return prop?.offset ?? item.key.offset;
    }
  }
  if (isMap(parent)) {
    const key = parent.items[index]!.key as Node | null;
    if (!key?.range) throw new SpecEditError("can't locate a key in the frontmatter");
    return key.range[0];
  }
  const item = parent.items[index] as Node | null;
  if (!item?.range) throw new SpecEditError("can't locate a list item in the frontmatter");
  let at = item.range[0] - 1;
  while (at >= 0 && (text[at] === " " || text[at] === "\t")) at--;
  if (text[at] !== "-")
    throw new SpecEditError("can't locate a list item's '-' in the frontmatter");
  return at;
}

/** Offset right after the line break that ends item `index` (its trailing comment included). */
function itemEnd(text: string, parent: YAMLMap | YAMLSeq, index: number): number {
  const item = parent.items[index];
  const node = (isMap(parent) ? ((item as Pair).value ?? (item as Pair).key) : item) as Node | null;
  const start = itemStart(text, parent, index);
  let end = node?.range?.[2] ?? start;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  const lineBreak = text.indexOf("\n", end);
  return lineBreak === -1 ? text.length : lineBreak + 1;
}

const lineStart = (text: string, offset: number): number => text.lastIndexOf("\n", offset - 1) + 1;

/** The comment at the end of the line `offset` is on, with the spaces before it (`"  # note"`). */
function trailingComment(text: string, offset: number): string | undefined {
  const lineBreak = text.indexOf("\n", offset);
  const line = text.slice(offset, lineBreak === -1 ? text.length : lineBreak).replace(/\r$/, "");
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (char === quote && !(quote === "'" && line[i + 1] === "'")) quote = undefined;
      else if (quote === "'" && char === "'") i++;
      else if (quote === '"' && char === "\\") i++;
    } else if (char === "'" || char === '"') {
      if (i === 0 || /[\s[{,:-]/.test(line[i - 1]!)) quote = char;
    } else if (char === "#" && i > 0 && /[ \t]/.test(line[i - 1]!)) {
      let from = i;
      while (from > 0 && /[ \t]/.test(line[from - 1]!)) from--;
      return line.slice(from);
    }
  }
  return undefined;
}

const isLineStart = (text: string, offset: number): boolean =>
  text.slice(lineStart(text, offset), offset).trim() === "";

/** Whether block lists inside maps are indented under their key (`key:\n  - a`), as in most specs. */
function detectIndentSeq(text: string, doc: Document.Parsed): boolean {
  let indented: boolean | undefined;
  visit(doc, {
    Pair: (_, pair) => {
      const key = pair.key as Node | null;
      const value = pair.value as Node | null;
      if (!isSeq(value) || value.flow || !key?.range || value.items.length === 0) return;
      let dash: number;
      try {
        dash = itemStart(text, value, 0);
      } catch {
        return undefined;
      }
      const keyColumn = key.range[0] - lineStart(text, key.range[0]);
      indented = dash - lineStart(text, dash) > keyColumn;
      return visit.BREAK;
    },
  });
  return indented ?? true;
}
