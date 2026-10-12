export class Worker extends Base {
  public run(): void {}
  private stop(): void {}
  protected static create(): Worker {
    return new Worker();
  }
  async start(): Promise<void> {}
  *items(): Generator<number> {}
  override toString(): string {
    return "worker";
  }
}
