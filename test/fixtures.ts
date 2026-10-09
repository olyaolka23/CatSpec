/**
 * Test fixtures: small sample repositories under `fixtures/<name>/`.
 *
 * Layout of a fixture: the repository's files (`src/…`), `catspec.yaml`, `docs/spec/<feature>/`,
 * `docs/architecture/adr/<name>-adr.md`, and `expected.json` with the results the test expects.
 * A test never works on `fixtures/` directly: `loadFixture` copies the fixture into its own
 * temporary directory, so tests can modify files without affecting each other.
 */
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const fixturesDir = resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures");

export interface LoadedFixture {
  /** Absolute path of the temporary copy. */
  dir: string;
  /** Deletes the temporary copy. */
  cleanup: () => Promise<void>;
}

/** Copies `fixtures/<name>` into a new temporary directory. */
export async function loadFixture(name: string): Promise<LoadedFixture> {
  const source = join(fixturesDir, name);
  const info = await stat(source).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`unknown fixture "${name}" (looked in ${source})`);

  const dir = await mkdtemp(join(tmpdir(), `catspec-fixture-${name}-`));
  await cp(source, dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
