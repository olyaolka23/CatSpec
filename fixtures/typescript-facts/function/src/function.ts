export function add(a: number, b: number): number {
  return a + b;
}

export async function load(url: string, retries = 3): Promise<Response> {
  return fetch(url);
}

function* ids(): Generator<number> {
  yield 1;
}
