import { randomUUID } from "node:crypto";

import { TokenStore } from "../storage/TokenStore";

/** Signs users in and out, and checks their tokens. */
export class AuthService {
  constructor(private readonly store: TokenStore) {}

  login(user: string, password: string): string {
    if (password.length === 0) throw new Error("empty password");
    const token = randomUUID();
    this.store.save(token, user);
    return token;
  }

  logout(token: string): void {
    this.store.remove(token);
  }

  validateToken(token: string): Promise<boolean> {
    return Promise.resolve(this.store.find(token) !== undefined);
  }
}
