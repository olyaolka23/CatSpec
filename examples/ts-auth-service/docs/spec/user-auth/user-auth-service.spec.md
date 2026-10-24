---
catspec: 1
id: user-auth-service
type: feature
status: ready
depends_on: [token-store]
bindings:
  - id: auth
    symbol: AuthService
    kind: class
    file: src/services/AuthService.ts
    constructor:
      requires: [TokenStore]
    members:
      - { name: login, params: [string, string], returns: string }
      - logout
      - name: validateToken
        params: [string]
        returns: "Promise<boolean>"
rules:
  - id: no-console
    class: structural
    forbid_call: "console.*"
    within: auth
---

# User authentication service

## Contracts

- [binding:auth] `AuthService` provides login, logout and token validation, on a `TokenStore`.
- [rule:no-console] No direct console logging.

## Tasks

- [x] Sign in and out.
- [x] Check tokens.
