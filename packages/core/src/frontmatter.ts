/**
 * Splits a spec file into its YAML frontmatter and its Markdown body (plan §D5, PBI
 * `frontmatter-parser`). The body is kept exactly as written, and every frontmatter node keeps its
 * source range, so diagnostics can point to the exact line and the CST editor can rewrite the
 * frontmatter without touching anything else.
 */
import { parseDocument, type Document } from "yaml";

import { createDiagnostic, type Diagnostic, type Location } from "./diagnostics.js";
import { LineIndex } from "./util.js";

export interface SpecSource {
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  /** The whole file. */
  text: string;
  /** `\r\n` when the frontmatter uses Windows line endings, else `\n`. */
  eol: "\n" | "\r\n";
  frontmatter: {
    /** Offset of the first frontmatter line (after the opening `---` line). */
    start: number;
    /** Offset of the closing `---` line. */
    end: number;
    /** The YAML between the delimiter lines, including its last line break. */
    text: string;
  };
  body: {
    /** Offset of the body: right after the closing `---` line and its line break. */
    start: number;
    /** The Markdown after the closing `---` line, exactly as in the file. */
    text: string;
    /** 1-based line of the body's first line. */
    line: number;
  };
  /** The parsed frontmatter; node ranges are offsets into `frontmatter.text`. */
  document: Document.Parsed;
  lines: LineIndex;
}

const DELIMITER = /^---[ \t]*$/;
const CLOSING = /^(---|\.\.\.)[ \t]*$/;

/** Result of splitting a file at its `---` delimiters, before the YAML is parsed. */
export interface SplitSource {
  eol: "\n" | "\r\n";
  frontmatter: SpecSource["frontmatter"];
  body: SpecSource["body"];
}

/** Splits `text` at the `---` lines, or explains why it can't. */
export function splitFrontmatter(text: string): SplitSource | { error: string } {
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const firstBreak = text.indexOf("\n", bom);
  const firstLine = text
    .slice(bom, firstBreak === -1 ? text.length : firstBreak)
    .replace(/\r$/, "");
  if (!DELIMITER.test(firstLine)) {
    return { error: "the file has no frontmatter: a spec must start with a '---' line" };
  }
  if (firstBreak === -1) {
    return { error: "the frontmatter is not closed: no '---' line after line 1" };
  }
  const eol = text[firstBreak - 1] === "\r" ? "\r\n" : "\n";
  const start = firstBreak + 1;

  for (let lineStart = start; lineStart <= text.length;) {
    const lineBreak = text.indexOf("\n", lineStart);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (CLOSING.test(line)) {
      const bodyStart = lineBreak === -1 ? text.length : lineBreak + 1;
      return {
        eol,
        frontmatter: { start, end: lineStart, text: text.slice(start, lineStart) },
        body: {
          start: bodyStart,
          text: text.slice(bodyStart),
          line: text.slice(0, bodyStart).split("\n").length,
        },
      };
    }
    if (lineBreak === -1) break;
    lineStart = lineBreak + 1;
  }
  return { error: "the frontmatter is not closed: no '---' line after line 1" };
}

/**
 * Parses a spec file. Returns the source when the file has a frontmatter block, even if the YAML
 * in it is invalid (those errors are in `diagnostics` as CS0101).
 */
export function parseSpecSource(
  text: string,
  file: string,
): { source?: SpecSource; diagnostics: Diagnostic[] } {
  const lines = new LineIndex(text);
  const split = splitFrontmatter(text);
  if ("error" in split) {
    return {
      diagnostics: [
        createDiagnostic("CS0101", {
          specLocation: { file, line: 1, column: 1 },
          message: `${file}: ${split.error}`,
        }),
      ],
    };
  }

  const document = parseDocument(split.frontmatter.text, { prettyErrors: false });
  const source: SpecSource = { file, text, ...split, document, lines };
  const diagnostics = document.errors.map((error) =>
    createDiagnostic("CS0101", {
      specLocation: frontmatterLocation(source, error.pos[0], error.pos[1]),
      message: `invalid YAML: ${error.message.split("\n")[0]!.replace(/ at line \d+.*$/, "")}`,
    }),
  );
  return { source, diagnostics };
}

/** File location of a range given as offsets into the frontmatter text. */
export function frontmatterLocation(source: SpecSource, start: number, end = start): Location {
  const from = source.lines.position(source.frontmatter.start + start);
  const to = source.lines.position(source.frontmatter.start + Math.max(start, end));
  return {
    file: source.file,
    line: from.line,
    column: from.column,
    endLine: to.line,
    endColumn: to.column,
  };
}

/** Reassembles a spec file from its parts with new frontmatter text; the rest is unchanged. */
export function withFrontmatter(source: SpecSource, frontmatterText: string): string {
  return (
    source.text.slice(0, source.frontmatter.start) +
    frontmatterText +
    source.text.slice(source.frontmatter.end)
  );
}
