/**
 * The user guide in the package: `catspec guide [page]` prints it, and the MCP server serves it
 * (`read_guide`, `catspec://guide/<page>`), so an agent can answer "how do I…?" from the guide of
 * the installed version. The pages are `docs/spec/catspec-user-guide/*.md`, copied into `guide/`
 * next to `dist/` by the build; in this repository they are read from `docs/` directly.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { didYouMean } from "@catspec/core";
import type { GuidePage } from "@catspec/mcp";

/** The guide in this repository, and the copy shipped in the package. */
const SOURCE = fileURLToPath(new URL("../../../docs/spec/catspec-user-guide/", import.meta.url));
const SHIPPED = fileURLToPath(new URL("../guide/", import.meta.url));

/** Links that leave the guide folder point at the design documents on GitHub. */
const REPOSITORY_DOCS = "https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/";
const REPOSITORY_ROOT = "https://github.com/olyaolka23/CatSpec/tree/main/";

/** The guide's own feature spec: not a page for users. */
const NOT_A_PAGE = "spec.md";

/** The order of `catspec guide`; pages not listed come last, by name. */
const ORDER = [
  "quick-start",
  "spec-format",
  "rules",
  "diagnostics",
  "commands",
  "agents",
  "workflow-presets",
  "faq",
];

/** The folder the guide is read from. */
export const guideDir = (): string => (existsSync(SOURCE) ? SOURCE : SHIPPED);

/** A page's text with the links that leave the guide made absolute. */
export const withAbsoluteLinks = (text: string): string =>
  text
    .replaceAll("](../../../", `](${REPOSITORY_ROOT}`)
    .replaceAll("](../", `](${REPOSITORY_DOCS}`);

/** Every page of the guide, in reading order. */
export async function loadGuide(dir = guideDir()): Promise<GuidePage[]> {
  const files = existsSync(dir)
    ? (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== NOT_A_PAGE)
    : [];
  const rank = (name: string): number => {
    const index = ORDER.indexOf(name);
    return index === -1 ? ORDER.length : index;
  };
  const pages = await Promise.all(
    files.map(async (file) => {
      const text = withAbsoluteLinks(
        (await readFile(join(dir, file), "utf8")).replace(/\r\n/g, "\n"),
      );
      const name = file.slice(0, -".md".length);
      const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? name;
      return { name, title, text };
    }),
  );
  return pages.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The list `catspec guide` prints without a page. */
export function guideIndex(pages: readonly GuidePage[]): string {
  const width = Math.max(0, ...pages.map((p) => p.name.length));
  return [
    "CatSpec user guide. Read a page with `catspec guide <page>`:",
    "",
    ...pages.map((p) => `  ${p.name.padEnd(width)}  ${p.title}`),
    "",
  ].join("\n");
}

/** The page called `name`; the error names the pages there are. */
export function findGuidePage(pages: readonly GuidePage[], name: string): GuidePage | string {
  const page = pages.find((p) => p.name === name.replace(/\.md$/, ""));
  if (page) return page;
  const names = pages.map((p) => p.name);
  const close = didYouMean(name, names);
  return (
    `no guide page "${name}" (pages: ${names.join(", ")})` +
    (close.length > 0 ? `; did you mean "${close[0]}"?` : "")
  );
}
