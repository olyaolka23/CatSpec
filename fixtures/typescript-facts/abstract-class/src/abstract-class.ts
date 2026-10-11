export abstract class Repository<T> {
  protected abstract table: string;

  abstract find(id: string): Promise<T | undefined>;

  count(): number {
    return 0;
  }
}
