/**
 * Writing lock files (plan §D7), PBIs `lock-files`, `ratchet` and `drift-and-accept`: after
 * `check --staged` (the hook), `baseline --rebuild` and `accept`. Only files whose content changes
 * are written.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  hasLockFile,
  lockPathOf,
  nextLock,
  serializeLock,
  type CheckResult,
  type NextLockOptions,
  type Spec,
  type SpecModel,
} from "@catspec/core";

/** Writes the lock files of `specs` after `result`; returns the paths written. */
export async function writeLocks(
  model: SpecModel,
  result: CheckResult,
  specs: readonly Spec[],
  options: NextLockOptions,
): Promise<string[]> {
  const written: string[] = [];
  for (const spec of specs) {
    if (!hasLockFile(spec)) continue;
    const lock = nextLock(
      spec,
      result.items,
      result.resolved.get(spec.id) ?? new Map(),
      model.locks.get(spec.id),
      options,
    );
    const path = lockPathOf(spec);
    const text = serializeLock(lock);
    if (model.lockTexts.get(path) === text) continue;
    const file = join(model.root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
    written.push(path);
  }
  return written;
}
