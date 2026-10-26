# CatSpec

**Specs that check the code.** CatSpec links your Markdown specs to real classes and methods,
checks them on every commit, and lets AI agents verify their own work before they say "done".
TypeScript and C#, on Linux, macOS and Windows, with Node.js 22.12 or newer.

## Get started

1. **Install and set up** in your repository:

   ```bash
   npm install --save-dev catspec
   npx catspec init --hooks --agents
   ```

   `init` writes `catspec.yaml`, the ADR log, an example feature in `docs/spec/example-feature/`,
   the pre-commit hook and the agent setup. On Windows PowerShell, use `npx.cmd` and `npm.cmd`.
2. **Check:** `npx catspec check`. Every problem has a code and a hint, and
   `npx catspec guide diagnostics` explains each code.
3. **Write your first spec:** copy `docs/spec/example-feature/example-greeter.spec.md` into
   `docs/spec/<your-feature>/` and bind it to one of your classes
   ([spec format](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/spec-format.md)).
4. **Connect your AI agent:** `claude mcp add catspec -- npx catspec mcp` for Claude Code; other
   agents in [agent integration](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/agents.md). Then ask it how to do
   something with CatSpec: it reads the user guide through the MCP server.
5. **Commit.** The pre-commit hook stops commits that break a contract that already passed.

The whole guide is also in your terminal: `npx catspec guide` lists the pages and
`npx catspec guide <page>` prints one. To remove CatSpec, run `npx catspec uninstall`.

## Learn more

- `npx catspec guide`: the user guide of the installed version, in your terminal. Agents read it
  through the MCP tool `read_guide`.
- [User guide](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/spec.md)
  and [examples](https://github.com/olyaolka23/CatSpec/tree/main/examples) on GitHub.

Apache-2.0
