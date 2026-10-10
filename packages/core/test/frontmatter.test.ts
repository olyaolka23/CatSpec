import { isMap, isScalar, type Node, type Pair } from "yaml";
import { describe, expect, it } from "vitest";

import {
  frontmatterLocation,
  parseSpecSource,
  splitFrontmatter,
  type SpecSource,
} from "../src/index.js";

/** Every frontmatter key with the file line and column it starts on. */
function keyPositions(source: SpecSource): Record<string, [number, number]> {
  const positions: Record<string, [number, number]> = {};
  const walk = (node: Node | null, prefix: string): void => {
    if (!isMap(node)) return;
    for (const pair of node.items as Pair<Node, Node | null>[]) {
      if (!isScalar(pair.key) || !pair.key.range) continue;
      const name = `${prefix}${String(pair.key.value)}`;
      const at = frontmatterLocation(source, pair.key.range[0]);
      positions[name] = [at.line, at.column];
      walk(pair.value, `${name}.`);
    }
  };
  walk(source.document.contents, "");
  return positions;
}

/** Line and column of every `key:` in the raw text, found without a YAML parser. */
function expectedPositions(text: string): Record<string, [number, number]> {
  const positions: Record<string, [number, number]> = {};
  const stack: { indent: number; name: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    if (/^---\s*$/.test(line)) break;
    const match = /^( *)([a-z_]+):/.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const name = [...stack.map((s) => s.name), match[2]!].join(".");
    positions[name] = [index + 1, indent + 1];
    stack.push({ indent, name: match[2]! });
  }
  return positions;
}

const NESTED = `---
catspec: 1
id: nested
type: feature
status: draft
links:
  pr: 12
  commit: abc
scope:
  - src/**
---

# Nested
`;

const SHAPES: Record<string, string> = {
  "nested keys": NESTED,
  "Windows line endings": NESTED.replace(/\n/g, "\r\n"),
  "no Markdown body": `---\ncatspec: 1\nid: no-body\ntype: feature\nstatus: draft\nlinks:\n  issue: 7\n---`,
};

describe("frontmatter-parser", () => {
  it.each(Object.entries(SHAPES))(
    "[AC-frontmatter-parser-1] gives the right line and column for every key: %s",
    (_, text) => {
      const { source, diagnostics } = parseSpecSource(text, "docs/spec/x/x.spec.md");
      expect(diagnostics).toEqual([]);
      expect(source).toBeDefined();
      const positions = keyPositions(source!);
      expect(Object.keys(positions).length).toBeGreaterThan(4);
      expect(positions).toEqual(expectedPositions(text));
    },
  );

  it("[AC-frontmatter-parser-2] reports CS0101 on line 1 for a file without frontmatter", () => {
    const { source, diagnostics } = parseSpecSource(
      "# Just Markdown\n",
      "docs/spec/x/plain.spec.md",
    );
    expect(source).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "CS0101",
      severity: "error",
      specLocation: { file: "docs/spec/x/plain.spec.md", line: 1, column: 1 },
    });
    expect(diagnostics[0]!.message).toContain("no frontmatter");
  });

  it("reports an unclosed frontmatter and invalid YAML as CS0101 at their line", () => {
    const unclosed = parseSpecSource("---\nid: x\n", "a.spec.md");
    expect(unclosed.diagnostics[0]).toMatchObject({ code: "CS0101", specLocation: { line: 1 } });
    expect(unclosed.diagnostics[0]!.message).toContain("not closed");

    const invalid = parseSpecSource("---\nid: x\nbad: [1, 2\n---\nbody\n", "a.spec.md");
    expect(invalid.diagnostics[0]!.code).toBe("CS0101");
    expect(invalid.diagnostics[0]!.message).toContain("invalid YAML");
    expect(invalid.diagnostics[0]!.specLocation!.line).toBeGreaterThanOrEqual(3);
  });

  it("keeps the body exactly as written, with its offsets", () => {
    const body = "\n# Title\r\n\r\nText with trailing spaces   \n\n\n";
    const text = `\uFEFF---\r\nid: x\r\n---\r\n${body}`;
    const split = splitFrontmatter(text);
    if ("error" in split) throw new Error(split.error);
    expect(split.eol).toBe("\r\n");
    expect(split.body.text).toBe(body);
    expect(text.slice(split.body.start)).toBe(body);
    expect(split.body.line).toBe(4);
    expect(split.frontmatter.text).toBe("id: x\r\n");
    expect(text.slice(split.frontmatter.start, split.frontmatter.end)).toBe("id: x\r\n");
  });

  it("accepts an empty frontmatter block and a closing '...' line", () => {
    const empty = splitFrontmatter("---\n---\nbody");
    expect("error" in empty ? empty.error : empty.frontmatter.text).toBe("");
    const dots = splitFrontmatter("---\nid: x\n...\nbody");
    expect("error" in dots ? dots.error : dots.body.text).toBe("body");
  });
});
