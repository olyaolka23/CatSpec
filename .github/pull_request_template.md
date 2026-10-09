## PBIs covered

<!-- One line per PBI: feature file and PBI id, e.g. `features/repo-scaffolding.md` · `monorepo-setup` -->

-

## Recommended CI

<!-- Every PR runs on Linux. Add `full-ci-mac` and/or `full-ci-win` when the change touches file paths,
processes, line endings or other platform-specific code, and before ticking a PBI or closing a feature. -->

- Labels: <!-- none | full-ci-mac | full-ci-win | both -->
- Why:

## PBI checklist

From [`plan.md` §3 Definition of Done](https://github.com/olyaolka23/CatSpec/blob/main/docs/spec/reactive-ast-linked-spec-engine/plan.md). Tick for each PBI above.

- [ ] every task of the PBI is done;
- [ ] every acceptance scenario of the PBI has a test tagged with its id, and **all tests pass**
      locally and in CI on Linux, and on macOS and Windows (PR labels `full-ci-mac` and `full-ci-win`)
      before the PBI is ticked;
- [ ] **requirements check:** the implementation was compared with every section the PBI
      cites (its `refs:` line). It does what they say, nothing is missing, and nothing was added beyond them.
      Any difference was raised with the owner and approved (Rule 3) before merging;
- [ ] no new lint or type errors; new diagnostics are in the code registry with docs text;
      CLI help and docs are updated;
- [ ] if the spec format changed: JSON Schema regenerated, and an ADR entry proposed and approved (Rule 2);
- [ ] the owner approved ticking the PBI's boxes in its feature file (Rule 3).
