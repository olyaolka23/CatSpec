/**
 * The user guide ships with the CLI: `catspec guide` prints it, and the MCP server serves it, so
 * people and agents read the guide of the installed version without a link to the repository.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "@catspec/mcp";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, describe, expect, it } from "vitest";

import { loadGuide, withAbsoluteLinks } from "../src/guide.js";
import { cliEngine, run } from "../src/index.js";

async function catspec(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const write = (text: string) => (stdout += text);
  const code = await run(args, { cwd: tmpdir(), stdout: { write }, stderr: { write } });
  return { code, stdout };
}

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("catspec guide", () => {
  it("lists the pages in reading order, without the guide's own spec", async () => {
    const result = await catspec(["guide"]);
    expect(result.code).toBe(0);
    const names = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(names.slice(0, 3)).toEqual(["quick-start", "spec-format", "rules"]);
    expect(names).toContain("commands");
    expect(names).not.toContain("spec");
    expect(result.stdout).toMatch(/quick-start\s+Quick start/);
  });

  it("prints a page; the command reference lists `guide` itself", async () => {
    const result = await catspec(["guide", "commands"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^# /);
    expect(result.stdout).toContain("catspec guide");
  });

  it("an unknown page is a usage error that names the pages", async () => {
    const result = await catspec(["guide", "comands"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('no guide page "comands"');
    expect(result.stdout).toContain('did you mean "commands"?');
  });

  it("links that leave the guide point at the repository", async () => {
    for (const page of await loadGuide()) {
      expect(page.text, page.name).not.toMatch(/\]\(\.\.\//);
    }
    expect(withAbsoluteLinks("[plan](../engine/plan.md) [ex](../../../examples/a/)")).toBe(
      "[plan](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/engine/plan.md) " +
        "[ex](https://github.com/olyaolka23/CatSpec/tree/main/examples/a/)",
    );
  });
});

describe("the guide over MCP", () => {
  it("read_guide lists the pages and returns one; catspec://guide/<page> serves it too", async () => {
    const root = mkdtempSync(join(tmpdir(), "catspec-guide-"));
    temps.push(root);
    const engine = cliEngine();
    const server = createServer({ root, engine, guide: () => loadGuide() });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "guide-reader", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      expect(client.getInstructions()).toMatch(/read_guide/);
      const index = await client.callTool({ name: "read_guide", arguments: {} });
      const pages = (index.structuredContent as { pages: { name: string }[] }).pages;
      expect(pages.map((p) => p.name)).toContain("diagnostics");

      const page = await client.callTool({ name: "read_guide", arguments: { page: "rules" } });
      expect((page.content as { text: string }[])[0]!.text).toMatch(/^# Rule catalogue/);

      const unknown = await client.callTool({ name: "read_guide", arguments: { page: "rulez" } });
      expect(unknown.isError).toBe(true);

      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain("catspec://guide/faq");
      const faq = await client.readResource({ uri: "catspec://guide/faq" });
      expect((faq.contents[0] as { text: string }).text).toMatch(/How do I remove CatSpec\?/);
    } finally {
      await client.close();
      await server.close();
      await engine.close();
    }
  });

  it("without a guide, the server has no read_guide", async () => {
    const root = mkdtempSync(join(tmpdir(), "catspec-guide-"));
    temps.push(root);
    const engine = cliEngine();
    const server = createServer({ root, engine });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "guide-reader", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("read_guide");
      expect(client.getInstructions()).not.toMatch(/read_guide/);
    } finally {
      await client.close();
      await server.close();
      await engine.close();
    }
  });
});
