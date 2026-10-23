---
catspec: 1
id: rule-engine-and-check
title: Rule engine and check
type: feature
status: ready
owners: ["@olyaolka23"]
depends_on: [core-public-api]
---

# Rule engine and check

Aggregate spec for feature F3 [`rule-engine-and-check`](./features/rule-engine-and-check.md) (plan §D17.1). It has no bindings or
rules: its contracts pass when every spec it depends on is `implemented`, and it is closed with
`catspec stage finish close rule-engine-and-check` (Definition of Done in the feature file).
