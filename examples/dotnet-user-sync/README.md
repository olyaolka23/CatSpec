# Example: .NET `UserUpdatedHandler`

A C# message handler with two specs in [`docs/spec/user-sync/`](./docs/spec/user-sync/) and a
layering rule in the [ADR log](./docs/architecture/adr/dotnet-user-sync-adr.md). CatSpec reads the
C# syntax only, so the example doesn't need the .NET SDK. CI runs this journey on every pull
request (`test/example-repos.test.ts`):

```bash
npm install --save-dev catspec
git init && git add . && git commit -m start
npx catspec status user-sync-handler in-progress   # cdc-core-events is implemented, so it may start
npx catspec status user-sync-handler implemented   # its contract passes
npx catspec install-hooks
git add . && git commit -m "user sync handler"
```

Then rename the class `UserHandler` to `UserUpdatedHandler` (and its file). With
`heal.mode: suggest` the commit fails with CS0210 and the spec edit; `npx catspec sync --apply`
makes the edit, and the next commit passes.
