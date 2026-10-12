export class Cache<K extends string, V = unknown> {
  get<T extends V>(key: K): T | undefined {
    return undefined;
  }
}

export function identity<T>(value: T): T {
  return value;
}

export interface Pair<A, B> {
  first: A;
  second: B;
}
