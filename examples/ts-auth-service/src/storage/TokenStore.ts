/** Where issued tokens live until they expire. */
export class TokenStore {
  private readonly tokens = new Map<string, string>();

  save(token: string, user: string): void {
    this.tokens.set(token, user);
  }

  find(token: string): string | undefined {
    return this.tokens.get(token);
  }

  remove(token: string): void {
    this.tokens.delete(token);
  }
}
