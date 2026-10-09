# Contributing to CatSpec

## Read first

1. [`AGENTS.md`](./AGENTS.md): where docs live and the approval rules. No merge into `main` and
   no change to any `.md` file without the owner's explicit approval.
2. The [ADR log](./docs/architecture/adr/reactive-ast-adr.md): code must not contradict an accepted decision.
3. The epic's [`plan.md`](./docs/spec/reactive-ast-linked-spec-engine/plan.md) (order, progress,
   Definition of Done) and the feature file in
   [`features/`](./docs/spec/reactive-ast-linked-spec-engine/features/) you are working on.

## Commands

Requires Node 20.19+ or 22.12+.

```sh
npm ci                      # install
npm test                    # build every package, then run all tests
npm run lint                # ESLint (warnings fail) and Prettier
npm run typecheck           # TypeScript over every package, script and test
npm run check:acceptance    # acceptance coverage; run after npm test
```

CI runs these on Linux (Node 20 and 22) for every pull request. macOS and Windows run only when the
pull request has the label `full-ci-mac` or `full-ci-win`.

## Tests

- Every Gherkin scenario in a feature file becomes a test whose name starts with its tag in
  brackets, e.g. `it("[AC-check-command-1] reports a missing member", …)`.
- `npm run check:acceptance` fails when a ticked PBI or a closed feature has a scenario without a
  passing test, or when a test uses a tag that isn't in any feature file.
- Test fixtures are small sample repositories in `fixtures/<name>/`. Load them with
  `loadFixture(name)` from `test/fixtures.ts`, which copies the fixture into a temporary directory.
