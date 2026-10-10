import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { Document, isMap, isScalar, isSeq, parse, type Node } from "yaml";
import { describe, expect, it } from "vitest";

import {
  applyPatch,
  classifyOp,
  classifyPatch,
  editYaml,
  parseSpecSource,
  SpecEditError,
  withFrontmatter,
  type PatchOp,
  type PatchPath,
  type SpecSource,
} from "../src/index.js";
import { ALIAS_BOMB } from "../../../test/temp-repo.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** The example of plan §D5.1, with comments, flow lists, quotes and a body. */
const EXAMPLE = `---
catspec: 1
id: user-sync-handler      # stable id
title: User sync handler
type: feature
status: in-progress
depends_on: [cdc-core-events, "auth-core"]
owners: ["@team-identity"]
scope:
  - src/Services/Identity/Handlers/**
bindings:
  # The bus handler.
  - id: handler
    symbol: Identity.Handlers.UserUpdatedHandler
    kind: class
    file: src/Services/Identity/Handlers/*.cs        # hint, optional
    implements: ["IMessageHandler<UserUpdatedEvent>"]
    constructor:
      requires: [ILogger, IEventStore]
    members:
      - name: HandleAsync
        kind: method
        params: [UserUpdatedEvent, CancellationToken]
        returns: Task
        modifiers: [public]

      - login   # shorthand
rules:
  - id: no-console
    class: structural
    forbid_call: 'Console.WriteLine'
    within: handler
waivers: []
---

# User sync handler

## Contracts
- [rule:no-console] No direct console logging.
`;

/** Spec texts used as golden inputs: inline shapes plus every spec-like Markdown file in the repo. */
function goldenInputs(): Record<string, string> {
  const inputs: Record<string, string> = {
    "plan §D5.1 example": EXAMPLE,
    "Windows line endings": EXAMPLE.replace(/\n/g, "\r\n"),
    "byte order mark": `\uFEFF${EXAMPLE}`,
    "no body": "---\ncatspec: 1\nid: x1\ntype: feature\nstatus: draft\n---",
    "no final line break": "---\nid: x1 # c\nlist:\n- a\n- 'b'\n---\nbody without line break",
    "block scalars": "---\nid: x1\ntext: |\n  line 1\n  line 2\nfolded: >-\n  a\n  b\n---\n",
    unicode: "---\nid: x1\ntitle: Привет, мир — 👋\n---\n# Привет\n",
  };
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : [],
    );
  for (const file of [...walk(join(repoRoot, "docs")), ...walk(join(repoRoot, "fixtures"))]) {
    const text = readFileSync(file, "utf8");
    if (text.startsWith("---")) inputs[relative(repoRoot, file).replace(/\\/g, "/")] = text;
  }
  return inputs;
}

const sourceOf = (text: string): SpecSource => {
  const { source, diagnostics } = parseSpecSource(text, "x.spec.md");
  if (!source) throw new Error(diagnostics.map((d) => d.message).join("\n"));
  return source;
};

/** Every scalar in the frontmatter with its path and value. */
function scalarPaths(
  node: Node | null,
  path: PatchPath = [],
): { path: PatchPath; value: unknown }[] {
  if (isScalar(node)) return path.length > 0 ? [{ path, value: node.value }] : [];
  if (isMap(node)) {
    return node.items.flatMap((pair) =>
      isScalar(pair.key)
        ? scalarPaths(pair.value as Node | null, [...path, String(pair.key.value)])
        : [],
    );
  }
  if (isSeq(node))
    return node.items.flatMap((item, i) => scalarPaths(item as Node | null, [...path, i]));
  return [];
}

describe("spec-cst-editor", () => {
  const inputs = goldenInputs();

  it.each(Object.entries(inputs))(
    "[AC-spec-cst-editor-1] writes the file back byte-for-byte after a no-op edit: %s",
    (_, text) => {
      const source = sourceOf(text);
      expect(applyPatch(source, [])).toBe(text);
      expect(withFrontmatter(source, source.frontmatter.text)).toBe(text);
      // Setting every scalar to the value it already has changes nothing either.
      const scalars = scalarPaths(source.document.contents as Node | null).filter(
        (s) => s.value === null || typeof s.value !== "object",
      );
      expect(scalars.length).toBeGreaterThan(0);
      const ops: PatchOp[] = scalars.map((s) => ({ op: "set", path: s.path, value: s.value }));
      expect(applyPatch(source, ops)).toBe(text);
    },
  );

  it("[AC-spec-cst-editor-2] keeps comments, key order and the body when the symbol changes", () => {
    const source = sourceOf(EXAMPLE);
    const out = applyPatch(source, [
      {
        op: "set",
        path: ["bindings", 0, "symbol"],
        value: "Accounts.Handlers.AccountUpdatedHandler",
      },
    ]);
    expect(out).toBe(
      EXAMPLE.replace(
        "    symbol: Identity.Handlers.UserUpdatedHandler\n",
        "    symbol: Accounts.Handlers.AccountUpdatedHandler\n",
      ),
    );
    expect(out).toContain(
      "    file: src/Services/Identity/Handlers/*.cs        # hint, optional\n",
    );
    expect(out.slice(out.indexOf("\n---\n"))).toBe(EXAMPLE.slice(EXAMPLE.indexOf("\n---\n")));
  });

  it("[AC-spec-cst-editor-3] classifies a symbol change as a location edit and a member removal as a contract edit", () => {
    const source = sourceOf(EXAMPLE);
    const classify = (op: PatchOp) => classifyOp(op, source);
    const rename: PatchOp = { op: "set", path: ["bindings", 0, "symbol"], value: "New.Name" };
    const removeMember: PatchOp = { op: "delete", path: ["bindings", 0, "members", 1] };
    expect(classify(rename)).toBe("location");
    expect(classify(removeMember)).toBe("contract");
    expect(classify({ op: "set", path: ["bindings", 0, "file"], value: ["a.cs", "b.cs"] })).toBe(
      "location",
    );
    expect(classify({ op: "delete", path: ["bindings", 0, "file"] })).toBe("location");
    expect(classify({ op: "delete", path: ["bindings", 0, "symbol"] })).toBe("contract");
    expect(classify({ op: "set", path: ["bindings", 0, "kind"], value: "class" })).toBe("contract");
    expect(classify({ op: "set", path: ["status"], value: "implemented" })).toBe("contract");
    expect(classifyPatch([rename], source)).toBe("location");
    expect(classifyPatch([rename, removeMember], source)).toBe("contract");
  });

  it("classifies anything that would add a binding, or a non-path file value, as a contract edit", () => {
    const source = sourceOf(EXAMPLE);
    const classify = (op: PatchOp) => classifyOp(op, source);
    // bindings[1] doesn't exist: setting its symbol appends a binding.
    expect(classify({ op: "set", path: ["bindings", 1, "symbol"], value: "Evil.Thing" })).toBe(
      "contract",
    );
    const noBindings = sourceOf("---\nid: x1\n---\n");
    expect(
      classifyOp({ op: "set", path: ["bindings", 0, "symbol"], value: "Evil.Thing" }, noBindings),
    ).toBe("contract");
    expect(classify({ op: "set", path: ["bindings", 0, "file"], value: { evil: true } })).toBe(
      "contract",
    );
    expect(classify({ op: "set", path: ["bindings", 0, "file"], value: [] })).toBe("contract");
    expect(classify({ op: "set", path: ["bindings", 0, "symbol"], value: "" })).toBe("contract");
    // `file` is a single path here, so it has no items to replace.
    expect(classify({ op: "set", path: ["bindings", 0, "file", 0], value: "a.cs" })).toBe(
      "contract",
    );
    const list = sourceOf("---\nbindings:\n  - symbol: A\n    file: [a.cs, b.cs]\n---\n");
    expect(classifyOp({ op: "delete", path: ["bindings", 0, "file", 1] }, list)).toBe("location");
    expect(classifyOp({ op: "set", path: ["bindings", 0, "file", 2], value: "c.cs" }, list)).toBe(
      "location",
    );
    expect(classifyOp({ op: "set", path: ["bindings", 0, "file", 5], value: "c.cs" }, list)).toBe(
      "contract",
    );
  });

  describe("golden edits", () => {
    const edit = (ops: PatchOp[], text = EXAMPLE): string => applyPatch(sourceOf(text), ops);
    const lines = (text: string): string[] => text.split("\n");
    /** Lines removed from and added to EXAMPLE. */
    function diff(out: string): { removed: string[]; added: string[] } {
      const a = lines(EXAMPLE);
      const b = lines(out);
      let start = 0;
      while (start < a.length && a[start] === b[start]) start++;
      let end = 0;
      while (
        end < a.length - start &&
        end < b.length - start &&
        a[a.length - 1 - end] === b[b.length - 1 - end]
      )
        end++;
      return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
    }

    it("keeps the quoting style of a replaced value, and quotes values that need it", () => {
      expect(
        diff(edit([{ op: "set", path: ["rules", 0, "forbid_call"], value: "console.log" }])),
      ).toEqual({
        removed: ["    forbid_call: 'Console.WriteLine'"],
        added: ["    forbid_call: 'console.log'"],
      });
      expect(diff(edit([{ op: "set", path: ["status"], value: "true" }])).added).toEqual([
        'status: "true"',
      ]);
      expect(diff(edit([{ op: "set", path: ["title"], value: "a: b # c" }])).added).toEqual([
        'title: "a: b # c"',
      ]);
      expect(diff(edit([{ op: "set", path: ["depends_on", 1], value: "x" }])).added).toEqual([
        'depends_on: [cdc-core-events, "x"]',
      ]);
    });

    it("removes list items and keys with their lines, keeping comments around them", () => {
      expect(diff(edit([{ op: "delete", path: ["bindings", 0, "members", 1] }]))).toEqual({
        removed: ["      - login   # shorthand"],
        added: [],
      });
      expect(diff(edit([{ op: "delete", path: ["bindings", 0, "members", 0] }])).removed).toEqual([
        "      - name: HandleAsync",
        "        kind: method",
        "        params: [UserUpdatedEvent, CancellationToken]",
        "        returns: Task",
        "        modifiers: [public]",
      ]);
      expect(diff(edit([{ op: "delete", path: ["bindings", 0, "id"] }]))).toEqual({
        removed: ["  - id: handler", "    symbol: Identity.Handlers.UserUpdatedHandler"],
        added: ["  - symbol: Identity.Handlers.UserUpdatedHandler"],
      });
      expect(diff(edit([{ op: "delete", path: ["depends_on", 0] }])).added).toEqual([
        'depends_on: ["auth-core"]',
      ]);
      expect(diff(edit([{ op: "delete", path: ["scope", 0] }]))).toEqual({
        removed: ["scope:", "  - src/Services/Identity/Handlers/**"],
        added: ["scope: []"],
      });
    });

    it("adds keys and list items in the style of the file", () => {
      expect(diff(edit([{ op: "set", path: ["links", "pr"], value: 42 }])).added).toEqual([
        "links:",
        "  pr: 42",
      ]);
      expect(
        diff(
          edit([
            {
              op: "set",
              path: ["bindings", 0, "members", 2],
              value: { name: "logout", params: ["*"] },
            },
          ]),
        ),
      ).toEqual({
        removed: [],
        added: ["      - name: logout", "        params:", '          - "*"'],
      });
      expect(diff(edit([{ op: "set", path: ["depends_on", 2], value: "billing" }])).added).toEqual([
        'depends_on: [cdc-core-events, "auth-core", billing]',
      ]);
      expect(
        diff(
          edit([
            { op: "set", path: ["waivers", 0], value: { rule: "no-console", reason: "boot" } },
          ]),
        ),
      ).toEqual({
        removed: ["waivers: []"],
        added: ["waivers:", "  - rule: no-console", "    reason: boot"],
      });
    });

    it("writes Windows line endings in a Windows file", () => {
      const crlf = EXAMPLE.replace(/\n/g, "\r\n");
      const out = edit([{ op: "set", path: ["links", "pr"], value: 42 }], crlf);
      expect(out).toContain("waivers: []\r\nlinks:\r\n  pr: 42\r\n---\r\n");
      expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    });

    it("quotes values that a flow collection can't hold plain", () => {
      const text = [
        "---",
        "bindings:",
        "  - symbol: A",
        "    file: [src/a.ts]",
        "    implements: [IFoo]",
        "rules:",
        "  - id: t",
        "    class: test",
        "    test: { symbol: A.B }",
        "---",
        "",
      ].join("\n");
      const glob = "src/**/*.{ts,tsx}";
      const out = (ops: PatchOp[]) => applyPatch(sourceOf(text), ops);
      expect(out([{ op: "set", path: ["bindings", 0, "file", 0], value: glob }])).toContain(
        '    file: ["src/**/*.{ts,tsx}"]\n',
      );
      expect(out([{ op: "set", path: ["bindings", 0, "file", 1], value: glob }])).toContain(
        '    file: [src/a.ts, "src/**/*.{ts,tsx}"]\n',
      );
      expect(
        out([{ op: "set", path: ["bindings", 0, "implements", 0], value: "IHandler<A, B>" }]),
      ).toContain('    implements: ["IHandler<A, B>"]\n');
      expect(out([{ op: "set", path: ["rules", 0, "test", "symbol"], value: "A, B" }])).toContain(
        '    test: { symbol: "A, B" }\n',
      );
    });

    it("finds list items and keys behind anchors, tags and comments", () => {
      const text = [
        "---",
        "id: x1",
        "owners:",
        "  - &o alice",
        "  - !!str bob",
        "  - # a note",
        "    carol",
        "scope: *o",
        "&k extra: 1",
        "---",
        "",
      ].join("\n");
      const out = (ops: PatchOp[]) => applyPatch(sourceOf(text), ops);
      expect(out([{ op: "set", path: ["id"], value: "x2" }])).toBe(
        text.replace("id: x1", "id: x2"),
      );
      expect(out([{ op: "delete", path: ["owners", 1] }])).toBe(
        text.replace("  - !!str bob\n", ""),
      );
      expect(out([{ op: "delete", path: ["owners", 2] }])).toBe(
        text.replace("  - # a note\n    carol\n", ""),
      );
      expect(out([{ op: "delete", path: ["extra"] }])).toBe(text.replace("&k extra: 1\n", ""));
    });

    it("refuses, instead of crashing, a frontmatter with too many aliases", () => {
      expect(() =>
        applyPatch(sourceOf(ALIAS_BOMB), [{ op: "set", path: ["id"], value: "y" }]),
      ).toThrow(SpecEditError);
    });

    it("refuses edits it can't make safely", () => {
      expect(() => edit([{ op: "delete", path: ["nope"] }])).toThrow(SpecEditError);
      expect(() => edit([{ op: "set", path: ["title", "x"], value: 1 }])).toThrow(/is a value/);
      expect(() => edit([{ op: "set", path: ["scope", 5], value: "x" }])).toThrow(/out of range/);
      expect(() => edit([{ op: "set", path: [], value: 1 }])).toThrow(SpecEditError);
    });
  });

  describe("property: edits change only what they target", () => {
    const word = fc.stringMatching(/^[a-z]{1,6}$/).map((w) => `k${w}`);
    const scalar = fc.oneof(
      fc.stringMatching(/^[A-Za-z0-9 .:#'"-]{0,12}$/),
      fc.integer({ min: -5, max: 500 }),
      fc.boolean(),
      fc.constant(null),
    );
    const tree: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
      value: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        scalar,
        fc.array(tie("value"), { maxLength: 3 }),
        fc.dictionary(word, tie("value"), { maxKeys: 3 }),
      ),
    })).value;
    const root = fc.dictionary(word, tree, { minKeys: 2, maxKeys: 5 });

    /** Renders a frontmatter in a random style, with a comment after each line that can take one. */
    const render = (
      value: Record<string, unknown>,
      indentSeq: boolean,
      quote: number,
      comments: boolean,
    ): string => {
      const text = new Document(value).toString({
        indentSeq,
        lineWidth: 0,
        defaultStringType: (["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"] as const)[quote]!,
      });
      if (!comments) return text;
      let n = 0;
      return text
        .split("\n")
        .map((line) =>
          line.trim() === "" || /[|>][-+]?$/.test(line) ? line : `${line}  # c${n++}`,
        )
        .join("\n");
    };

    const allPaths = (
      value: unknown,
      path: PatchPath = [],
    ): { path: PatchPath; value: unknown }[] => {
      const here = path.length > 0 ? [{ path, value }] : [];
      if (Array.isArray(value))
        return [...here, ...value.flatMap((v, i) => allPaths(v, [...path, i]))];
      if (value && typeof value === "object") {
        return [...here, ...Object.entries(value).flatMap(([k, v]) => allPaths(v, [...path, k]))];
      }
      return here;
    };

    /** The expected result of an op on plain data (an oracle independent of the yaml library). */
    function applyToData(data: unknown, op: PatchOp): unknown {
      const copy = structuredClone(data) as Record<string, unknown>;
      let parent: Record<string | number, unknown> = copy;
      for (const segment of op.path.slice(0, -1))
        parent = parent[segment] as Record<string | number, unknown>;
      const last = op.path[op.path.length - 1]!;
      if (op.op === "set") parent[last] = op.value;
      else if (Array.isArray(parent)) parent.splice(last as number, 1);
      else delete parent[last];
      return copy;
    }

    const commentsOf = (text: string): string[] => [...text.matchAll(/# c\d+/g)].map((m) => m[0]);

    it("set, delete and add keep everything else, including comments and the body", () => {
      fc.assert(
        fc.property(
          root,
          fc.boolean(),
          fc.integer({ min: 0, max: 2 }),
          fc.boolean(),
          fc.nat(),
          fc.integer({ min: 0, max: 2 }),
          scalar,
          word,
          (data, indentSeq, quote, comments, pick, kind, newValue, newKey) => {
            const yamlText = render(data, indentSeq, quote, comments);
            const body = "\n# Body\n\n- keep me exactly  \n";
            const text = `---\n${yamlText}---${body}`;
            const paths = allPaths(data);
            const target = paths[pick % paths.length]!;

            let op: PatchOp;
            if (kind === 0) {
              op = { op: "set", path: target.path, value: newValue };
            } else if (kind === 1) {
              if (target.path.length === 1 && Object.keys(data).length === 1) return;
              op = { op: "delete", path: target.path };
            } else if (Array.isArray(target.value)) {
              op = { op: "set", path: [...target.path, target.value.length], value: newValue };
            } else if (target.value && typeof target.value === "object") {
              if (newKey in target.value) return;
              op = { op: "set", path: [...target.path, newKey], value: newValue };
            } else {
              return;
            }

            const out = applyPatch(sourceOf(text), [op]);
            expect(out.endsWith(`---${body}`)).toBe(true);
            const frontmatter = out.slice(4, out.lastIndexOf("---"));
            expect(parse(frontmatter) ?? {}).toEqual(applyToData(data, op));

            const before = commentsOf(yamlText);
            const after = commentsOf(frontmatter);
            if (
              op.op === "set" &&
              kind === 0 &&
              (target.value === null || typeof target.value !== "object")
            ) {
              // Replacing a scalar touches nothing but that scalar.
              expect(after).toEqual(before);
            } else if (kind === 2) {
              expect(after).toEqual(expect.arrayContaining(before));
            } else {
              for (const comment of after) expect(before).toContain(comment);
            }
          },
        ),
        { numRuns: 400 },
      );
    });

    it("edits through editYaml are the same as through applyPatch", () => {
      const yamlText = "a: 1 # one\nb:\n  - x\n";
      expect(editYaml(yamlText, [{ op: "set", path: ["a"], value: 2 }])).toBe(
        "a: 2 # one\nb:\n  - x\n",
      );
    });
  });
});
