# User authentication: plan

The work items, in order:

1. [`token-store`](./token-store.spec.md): where tokens are kept (implemented).
2. [`user-auth-service`](./user-auth-service.spec.md): `AuthService` on a `TokenStore`: sign in,
   sign out, check a token. Depends on `token-store`.
