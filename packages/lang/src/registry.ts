/**
 * The adapter registry (plan §D11.2, PBI `adapter-interface`): routes a file to the language
 * adapter whose extensions and `languages.<id>.include` / `exclude` globs match it.
 */
import { globMatcher, type LanguageAdapter } from "@catspec/core";

/** The file set of one language, as in `languages.<id>` of `catspec.yaml`. */
export interface LanguageFiles {
  include: readonly string[];
  exclude: readonly string[];
}

interface Entry {
  adapter: LanguageAdapter;
  included: (path: string) => boolean;
  excluded: (path: string) => boolean;
}

export class AdapterRegistry {
  private readonly entries = new Map<string, Entry>();

  /**
   * @param languages The `languages` section of the config. An adapter whose id has no entry
   *   gets no files.
   */
  constructor(private readonly languages: Readonly<Record<string, LanguageFiles | undefined>>) {}

  /** Adds an adapter. Throws when an adapter with the same id is already registered. */
  register(adapter: LanguageAdapter): this {
    if (this.entries.has(adapter.id)) {
      throw new Error(`a language adapter with id "${adapter.id}" is already registered`);
    }
    const files = this.languages[adapter.id];
    this.entries.set(adapter.id, {
      adapter,
      included: files && files.include.length > 0 ? globMatcher(files.include) : () => false,
      excluded: files && files.exclude.length > 0 ? globMatcher(files.exclude) : () => false,
    });
    return this;
  }

  /** The adapter with this id, if registered. */
  get(id: string): LanguageAdapter | undefined {
    return this.entries.get(id)?.adapter;
  }

  /** Registered adapters, in registration order. */
  adapters(): LanguageAdapter[] {
    return [...this.entries.values()].map((entry) => entry.adapter);
  }

  /**
   * The adapter for a root-relative POSIX path: the first registered one whose extensions and
   * include globs match and whose exclude globs don't. Undefined when the file belongs to no
   * language.
   */
  resolve(path: string): LanguageAdapter | undefined {
    for (const { adapter, included, excluded } of this.entries.values()) {
      if (
        adapter.extensions.some((extension) => path.endsWith(extension)) &&
        included(path) &&
        !excluded(path)
      ) {
        return adapter;
      }
    }
    return undefined;
  }
}
