/** `catspec show-facts <file>`: a hidden debug command that prints a file's facts (plan §D11.2). */
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import {
  gitBlobSha,
  parseErrorDiagnostics,
  toPosix,
  type CatspecConfig,
  type Diagnostic,
  type FileFacts,
  type LanguageAdapter,
} from "@catspec/core";
import { AdapterRegistry } from "@catspec/lang";
import { TypeScriptAdapter } from "@catspec/lang-typescript";

/** The language adapters the CLI ships with. */
export const defaultAdapters = (): LanguageAdapter[] => [new TypeScriptAdapter()];

export class UnknownLanguageError extends Error {}

/**
 * Extracts the facts of `file` (relative to `cwd`). The file is routed by the `languages` globs
 * of the config; a file outside them still goes to the adapter for its extension, since this is
 * a debug command.
 */
export async function showFacts(
  root: string,
  cwd: string,
  config: CatspecConfig,
  file: string,
): Promise<{ facts: FileFacts; diagnostics: Diagnostic[] }> {
  const absolute = resolve(cwd, file);
  const path = toPosix(relative(root, absolute));
  const registry = new AdapterRegistry(config.languages);
  for (const adapter of defaultAdapters()) registry.register(adapter);
  const adapter =
    registry.resolve(path) ?? registry.adapters().find((a) => a.extensions.includes(extname(path)));
  if (!adapter) throw new UnknownLanguageError(`no language adapter for ${path}`);

  const bytes = await readFile(absolute);
  await adapter.load();
  const facts = adapter.extract({ path, text: bytes.toString("utf8"), blobSha: gitBlobSha(bytes) });
  return { facts, diagnostics: parseErrorDiagnostics(facts) };
}
