/**
 * The Markdown body of a spec (plan §D5.4), PBI `body-parser`: references to rules and bindings,
 * the bullets under `Contracts` / `Invariants`, and the `Tasks` checklist. The body is otherwise
 * opaque and returned to agents as written.
 */
import type { Heading, List, ListItem, Nodes, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { LineIndex } from "./util.js";

export interface BodyReference {
  kind: "rule" | "binding";
  id: string;
  /** File position (1-based). */
  line: number;
  column: number;
}

export interface ContractBullet {
  text: string;
  line: number;
  column: number;
  references: BodyReference[];
}

export interface TaskItem {
  text: string;
  done: boolean;
  line: number;
}

export interface SpecBody {
  /** Text of the first `#` heading. */
  title?: string;
  references: BodyReference[];
  /** Top-level bullets under a `Contracts` or `Invariants` heading. */
  contracts: ContractBullet[];
  /** Checklist items under a `Tasks` heading. */
  tasks: TaskItem[];
  /** `ADR-NNN` ids of the headings that start with one (the ADR log of an architecture spec). */
  adrIds: string[];
}

const REFERENCE = /\[(rule|binding):([^\]\s]+)\]/g;
const CHECKBOX = /^\[([ xX])\](?:[ \t]+|$)/;
const ADR_HEADING = /^(ADR-\d+)\b/;

/** Parses a spec body. `firstLine` is the file line the body starts on. */
export function parseBody(markdown: string, firstLine: number): SpecBody {
  const tree = unified().use(remarkParse).parse(markdown);
  const toFileLine = (line: number): number => firstLine + line - 1;
  const body: SpecBody = { references: [], contracts: [], tasks: [], adrIds: [] };

  const lines = new LineIndex(markdown);
  const at = (offset: number): { line: number; column: number } => {
    const { line, column } = lines.position(offset);
    return { line: toFileLine(line), column };
  };

  const referencesIn = (node: Nodes): BodyReference[] => {
    const found: BodyReference[] = [];
    visit(node, (child) => {
      const start = child.position?.start.offset;
      if (start === undefined) return;
      if (child.type === "text") {
        // Positions come from the source, not from the decoded text (entities, indentation).
        const source = markdown.slice(start, child.position!.end.offset);
        let cursor = 0;
        for (const match of child.value.matchAll(REFERENCE)) {
          const index = source.indexOf(match[0], cursor);
          if (index !== -1) cursor = index + match[0].length;
          const kind = match[1] as "rule" | "binding";
          found.push({ kind, id: match[2]!, ...at(start + Math.max(index, 0)) });
        }
      } else if (child.type === "linkReference" || child.type === "link") {
        // `[rule:x][]` with a definition, or `[rule:x](#x)`.
        const label = child.type === "linkReference" ? (child.label ?? "") : plainText(child);
        const match = /^(rule|binding):(\S+)$/.exec(label.trim());
        if (match)
          found.push({ kind: match[1] as "rule" | "binding", id: match[2]!, ...at(start) });
      }
    });
    return found;
  };

  body.references = referencesIn(tree);

  const headings: { name: string; depth: number }[] = [];
  const inSection = (...names: string[]): boolean =>
    headings.some((h) => names.includes(h.name.toLowerCase()));

  for (const node of tree.children) {
    if (node.type === "heading") {
      const name = plainText(node).trim();
      while (headings.length > 0 && headings[headings.length - 1]!.depth >= node.depth) {
        headings.pop();
      }
      headings.push({ name, depth: node.depth });
      if (node.depth === 1 && body.title === undefined) body.title = name;
      const adr = ADR_HEADING.exec(name);
      if (adr) body.adrIds.push(adr[1]!);
      continue;
    }
    if (node.type !== "list") continue;
    if (inSection("contracts", "invariants")) {
      for (const item of node.children) {
        if (!item.position) continue;
        body.contracts.push({
          text: plainText(item).trim(),
          line: toFileLine(item.position.start.line),
          column: item.position.start.column,
          references: referencesIn(item),
        });
      }
    }
    if (inSection("tasks")) collectTasks(node, body.tasks, toFileLine);
  }
  return body;
}

function collectTasks(list: List, tasks: TaskItem[], toFileLine: (line: number) => number): void {
  for (const item of list.children) {
    const text = itemText(item);
    const box = CHECKBOX.exec(text);
    if (box && item.position) {
      tasks.push({
        text: text.slice(box[0].length).trim(),
        done: box[1] !== " ",
        line: toFileLine(item.position.start.line),
      });
    }
    for (const child of item.children) {
      if (child.type === "list") collectTasks(child, tasks, toFileLine);
    }
  }
}

/** Text of a list item's own first paragraph (not its nested lists). */
function itemText(item: ListItem): string {
  const first = item.children[0];
  return first?.type === "paragraph" ? plainText(first) : "";
}

function plainText(node: Nodes | Heading | RootContent): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(plainText).join("");
  return "";
}

function visit(node: Nodes, fn: (node: Nodes) => void): void {
  fn(node);
  if ("children" in node) for (const child of node.children as Nodes[]) visit(child, fn);
}
