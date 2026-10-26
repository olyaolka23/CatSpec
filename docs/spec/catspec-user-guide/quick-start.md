# Quick start

CatSpec 0.1 checks TypeScript and C# code against Markdown specs. It needs Node.js 22.12 or newer
and git 2.30 or newer, on Linux, macOS or Windows. There is nothing to compile: the parsers are
WebAssembly.

## 1. Install and set up

```bash
npm install --save-dev catspec
npx catspec init --with-sdd-example   # add --hooks for the pre-commit hook, --agents for AI agents
```

`init` writes:

```
catspec.yaml                                   # config; every key is optional
docs/architecture/adr/<repo>-adr.md            # architecture decisions + repository-wide rules
```

and, with `--with-sdd-example`, the example feature used below:

```
docs/spec/example-feature/spec.md, plan.md     # human docs of an example feature
docs/spec/example-feature/example-greeter.spec.md   # an example machine spec
```

Both languages are on by default (`src/**/*.{ts,tsx}` and `src/**/*.cs`); point
`languages.<lang>.include` in `catspec.yaml` at your sources.

The ADR log, and what to change if you already have ADRs, is explained in
[Global rules](./rules.md#the-adr-log-that-init-writes).

## 2. A spec, from draft to implemented

The example spec binds a class `Greeter` with a method `greet`:

```markdown
---
catspec: 1
id: example-greeter
type: feature
status: draft
bindings:
  - id: greeter
    symbol: Greeter
    kind: class
    members:
      - name: greet
        kind: method
---
```

A `draft` spec isn't enforced. Start the work, then check:

```console
$ npx catspec status example-greeter in-progress
example-greeter: draft → in-progress

$ npx catspec check
⚠ example-greeter  docs/spec/example-feature/example-greeter.spec.md
  12:9  CS0203 member greet missing in Greeter
               at src/greeter.ts:1:14
               ↳ did you mean hello? (src/greeter.ts:2:3)
0 errors, 1 warning in 2 specs
```

In progress, an unfinished contract is a warning. `check --spec` checks one spec as if it were
implemented and ends with DONE or NOT DONE:

```console
$ npx catspec check --spec example-greeter
✖ binding:greeter.greet  CS0203 member greet missing in Greeter
    expected: method greet
    found:    method hello(name: string): string
NOT DONE
```

After renaming `hello` to `greet`, it says DONE, and the spec can be marked implemented (CatSpec
refuses while a contract fails):

```console
$ npx catspec status example-greeter implemented
example-greeter: in-progress → implemented
```

From now on, breaking the contract is an error.

## 3. Check every commit

```bash
npx catspec install-hooks       # or: npx catspec init --hooks
```

The pre-commit hook runs `catspec check --staged` on what you are committing, and updates the
lock files (`<spec-id>.lock.json`, next to each spec; commit them). It works with husky and
lefthook too. `git commit --no-verify` or `CATSPEC_SKIP=1` skips it, and the next run warns.

## Next

- [Spec format](./spec-format.md) and [rules](./rules.md): what you can check.
- [Agent integration](./agents.md): let Claude Code, Cursor or Windsurf run these commands.
- [Workflow presets](./workflow-presets.md): plug CatSpec into OpenSpec, Spec Kit or your skills.
- The example repositories [`examples/ts-auth-service`](../../../examples/ts-auth-service/) and
  [`examples/dotnet-user-sync`](../../../examples/dotnet-user-sync/) show a whole journey.
