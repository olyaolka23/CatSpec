# Example: TypeScript `AuthService`

A small TypeScript service with two specs in [`docs/spec/user-auth/`](./docs/spec/user-auth/) and
an architecture rule in the [ADR log](./docs/architecture/adr/ts-auth-service-adr.md). CI runs this
journey on every pull request (`test/example-repos.test.ts`):

```bash
npm install                                   # installs catspec
git init && git add . && git commit -m start
npx catspec check                             # 0 errors: token-store is implemented, user-auth-service ready
npx catspec status user-auth-service in-progress
npx catspec check --spec user-auth-service    # DONE: AuthService has login, logout, validateToken
npx catspec status user-auth-service implemented
npx catspec install-hooks
git add . && git commit -m "auth service"     # the hook writes user-auth-service.lock.json
```

Then rename `validateToken` to `checkToken` and commit: the hook blocks the commit, with a
CS0301 regression (the member passed before), `did you mean checkToken?`, and CS0703. Rename
it back, or change the spec.
