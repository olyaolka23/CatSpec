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

   `init` writes `catspec.yaml`, the ADR log, the pre-commit hook and the agent setup. Add
   `--with-sdd-example` for an example feature in `docs/spec/example-feature/`. On Windows
   PowerShell, use `npx.cmd` and `npm.cmd`.
2. **Connect your AI agent:** `claude mcp add catspec -- npx catspec mcp` for Claude Code; Codex,
   Cursor, Copilot and other agents in [agent integration](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/agents.md). Then ask it how to do
   something with CatSpec: it reads the user guide through the MCP server.
3. **Write your first spec:** in `docs/spec/<your-feature>/`, write `<spec-id>.spec.md` and bind it
   to one of your classes
   ([spec format](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/spec-format.md)).
   `npx catspec init --with-sdd-example` writes a complete example to copy from.
4. **Check:** `npx catspec check`. Every problem has a code and a hint, and
   `npx catspec guide diagnostics` explains each code.
5. **Commit.** The pre-commit hook stops commits that break a contract that already passed.

The whole guide is also in your terminal: `npx catspec guide` lists the pages and
`npx catspec guide <page>` prints one.

**To remove CatSpec**, run `npx catspec uninstall` in the repository *before* `npm uninstall catspec`
(and `npm uninstall -g catspec` for a global install). npm can't clean up after a package, so the
pre-commit hook stays in the repository until `catspec uninstall` removes it. Add `--files` to also
delete `catspec.yaml` and the example files `init` wrote. If CatSpec is already gone, remove the hook
by hand: delete `.git/hooks/pre-commit` (or `pre-commit` in the folder `git config core.hooksPath`
names) and rename `pre-commit.catspec-backup`, if it is there, back to `pre-commit`. With husky,
delete the `catspec-managed` block from `.husky/pre-commit`; with lefthook, delete the `catspec`
command from `lefthook.yml` and run `lefthook install`.

## Learn more

- `npx catspec guide`: the user guide of the installed version, in your terminal. Agents read it
  through the MCP tool `read_guide`.
- [User guide](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/spec.md)
  and [examples](https://github.com/olyaolka23/CatSpec/tree/main/examples) on GitHub.

Apache-2.0
