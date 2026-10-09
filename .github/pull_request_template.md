## PBIs covered

<!-- One line per PBI: feature file and PBI id, e.g. `features/repo-scaffolding.md` · `monorepo-setup` -->

-

## PBI checklist

From [`plan.md` §3 Definition of Done](../docs/spec/reactive-ast-linked-spec-engine/plan.md). Tick for each PBI above.

- [ ] every task of the PBI is done;
- [ ] every acceptance scenario of the PBI has a test tagged with its id, and **all tests pass**
      locally and in CI on Linux, macOS and Windows;
- [ ] **requirements check:** the implementation was compared with every section the PBI
      cites (its `refs:` line). It does what they say, nothing is missing, and nothing was added beyond them.
      Any difference was raised with the owner and approved (Rule 3) before merging;
- [ ] no new lint or type errors; new diagnostics are in the code registry with docs text;
      CLI help and docs are updated;
- [ ] if the spec format changed: JSON Schema regenerated, and an ADR entry proposed and approved (Rule 2);
- [ ] the owner approved ticking the PBI's boxes in its feature file (Rule 3).
