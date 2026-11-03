# CatSpec

**Specs that check the code.** CatSpec links your Markdown specs to real classes and methods,
checks them on every commit, and lets AI agents verify their own work before they say "done".
TypeScript and C#, on Linux, macOS and Windows, with Node.js 22.12 or newer.

## Get started

1. **Install and set up** in your repository:

   ```bash
   npm install -g catspec
   catspec init --hooks --agents --with-adr
   ```

   `init` always writes `catspec.yaml`. Each option adds one thing
   ([`init` options](https://github.com/olyaolka23/CatSpec/blob/main/README.md#init-options)): `--hooks` the git pre-commit check, `--agents`
   the setup for AI agents, `--with-adr` a file for
   [repository-wide rules](https://github.com/olyaolka23/CatSpec/blob/main/README.md#repository-wide-rules-optional-adr-file) (optional). On
   Windows PowerShell, use `catspec.cmd` and `npm.cmd`. To pin one version for the whole team, use
   `npm install --save-dev catspec` and `npx catspec …` instead.
2. **Connect your AI agent:** `claude mcp add catspec -- npx catspec mcp` for Claude Code; Codex,
   Cursor, Copilot and other agents in [agent integration](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/agents.md). Then ask it how to do
   something with CatSpec: it reads the user guide through the MCP server.
3. **Write your first spec:** in `docs/spec/<your-feature>/`, write `<spec-id>.spec.md` and bind it
   to one of your classes
   ([spec format](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/catspec-user-guide/spec-format.md)).
   `catspec init --with-sdd-example` writes a complete example to copy from.
4. **Check:** `catspec check`. Every problem has a code and a hint, and
   `catspec guide diagnostics` explains each code.
5. **Commit.** The pre-commit hook stops commits that break a contract that already passed.

The whole guide is also in your terminal: `catspec guide` lists the pages and
`catspec guide <page>` prints one.

**To remove CatSpec**, run `catspec uninstall` in the repository *before* `npm uninstall -g catspec`
(or `npm uninstall catspec` for a project install). npm can't clean up after a package, so the
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
