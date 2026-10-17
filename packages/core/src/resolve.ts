/**
 * Binding resolution (plan §D11.5, ADR-005), PBI `binding-resolver`: finds the declaration a
 * binding points to. The `file` hint is tried first, then the files the binding resolved to last
 * time (its lock file, F5), then every source file, so a moved file still resolves. Not found →
 * CS0201 with did-you-mean; several candidates → CS0202; C# `partial` parts are merged.
 */
import { codeLocation, formatLocation, type SymbolEntry, type SymbolTable } from "./codebase.js";
import { compareStrings, createDiagnostic, type Diagnostic } from "./diagnostics.js";
import type { FileFacts, SymbolFact } from "./facts.js";
import { BINDING_KINDS, type Binding } from "./spec-schema.js";
import { specLocation, type Spec } from "./spec.js";
import { didYouMean, globMatcher, listOf } from "./util.js";

export interface ResolvedBinding {
  binding: Binding;
  /** The declaration; for C# partial types, the parts merged into one. */
  symbol: SymbolFact;
  /** The file of the declaration (of its first part). */
  file: FileFacts;
  /** The files of every part. */
  files: string[];
  /** The declarations merged into `symbol`, each with its file; one unless C# `partial`. */
  parts: { symbol: SymbolFact; file: FileFacts }[];
}

export interface BindingResolution {
  resolved?: ResolvedBinding;
  diagnostics: Diagnostic[];
  /**
   * True when neither the hint nor the locked files had the declaration, so every source file was
   * searched: a result that depends on the whole repository (`check --staged` reads it all then).
   */
  searched: boolean;
}

const TYPE_KINDS = new Set<string>(BINDING_KINDS);

/** `src/auth/service#AuthService.login` → module `src/auth/service`, name `AuthService.login`. */
export function splitSymbol(symbol: string): { module?: string; name: string } {
  const hash = symbol.lastIndexOf("#");
  return hash === -1
    ? { name: symbol }
    : { module: symbol.slice(0, hash).replace(/^\.\//, ""), name: symbol.slice(hash + 1) };
}

/** True when `path` is the module `module`: with or without the extension, or ending with it. */
export const inModule = (path: string, module: string): boolean => {
  const bare = path.replace(/\.[^./]+$/, "");
  const target = module.replace(/\.[^./]+$/, "");
  return bare === target || bare.endsWith(`/${target}`);
};

/**
 * Resolves a binding in `table`. `locked` are the files the binding resolved to last time (from
 * its lock file), tried after the `file` hint.
 */
export function resolveBinding(
  spec: Spec,
  binding: Binding,
  table: SymbolTable,
  locked: readonly string[] = [],
): BindingResolution {
  const { module, name } = splitSymbol(binding.symbol);
  const kindOk = (s: SymbolFact): boolean =>
    binding.kind ? s.kind === binding.kind : TYPE_KINDS.has(s.kind);
  const langOk = (f: FileFacts): boolean => !binding.lang || f.lang === binding.lang;
  const hinted = binding.file ? globMatcher(binding.file) : () => false;
  const inHint = (e: SymbolEntry): boolean =>
    binding.file !== undefined && (hinted(e.file.path) || binding.file.includes(e.file.path));

  const named = table
    .find(name)
    .filter((e) => langOk(e.file) && (!module || inModule(e.file.path, module)));
  const ofKind = named.filter((e) => kindOk(e.symbol));
  const inHinted = ofKind.filter(inHint);
  const inLocked = ofKind.filter((e) => locked.includes(e.file.path));
  const searched = inHinted.length === 0 && inLocked.length === 0;
  const groups = groupOverloads(
    inHinted.length > 0 ? inHinted : inLocked.length > 0 ? inLocked : ofKind,
  );

  const at = specLocation(spec.source, ["bindings", binding.index, "symbol"]);
  const base = {
    spec: spec.id,
    specLocation: at,
    bindingId: binding.id,
    item: `binding:${binding.id}`,
  };
  const what = `${binding.kind ?? "symbol"} ${binding.symbol}`;

  if (groups.length === 0) {
    const otherKind = named[0];
    if (otherKind) {
      return {
        searched,
        diagnostics: [
          createDiagnostic("CS0201", {
            ...base,
            codeLocation: codeLocation(otherKind.file.path, otherKind.symbol.nameRange),
            message:
              `binding "${binding.id}": no ${what}; found ${otherKind.symbol.kind} ` +
              `${otherKind.symbol.qualifiedName} at ${formatLocation(otherKind.file.path, otherKind.symbol.nameRange)}`,
            expected: what,
            actual: `${otherKind.symbol.kind} ${otherKind.symbol.qualifiedName}`,
            suggestions: [
              { message: `change the binding's kind to ${otherKind.symbol.kind}, or the code` },
            ],
          }),
        ],
      };
    }
    const close = closeNames(name, table, kindOk, langOk, inHint);
    return {
      searched,
      diagnostics: [
        createDiagnostic("CS0201", {
          ...base,
          message:
            `binding "${binding.id}": ${what} not found` +
            (binding.file ? ` in ${listOf(binding.file)} or anywhere else` : ""),
          expected: what,
          actual: close.length > 0 ? close.map((c) => c.symbol.qualifiedName) : "nothing",
          suggestions:
            close.length > 0
              ? close.map((c) => ({
                  message: `did you mean ${c.symbol.name}? (${formatLocation(c.file.path, c.symbol.nameRange)})`,
                }))
              : [{ message: "fix the symbol or the file hint, or restore the code" }],
        }),
      ],
    };
  }

  const parts = groups.map((g) => g[0]!);
  if (parts.length > 1 && !parts.every((p) => p.symbol.partial)) {
    const where = parts.map((p) => formatLocation(p.file.path, p.symbol.nameRange));
    return {
      searched,
      diagnostics: [
        createDiagnostic("CS0202", {
          ...base,
          codeLocation: codeLocation(parts[0]!.file.path, parts[0]!.symbol.nameRange),
          message: `binding "${binding.id}": ${what} is ambiguous; ${parts.length} declarations match: ${listOf(where)}`,
          expected: what,
          actual: where,
          suggestions: [
            {
              message:
                "qualify the symbol (Namespace.Type or path/to/module#Name) or add a file hint",
            },
          ],
        }),
      ],
    };
  }

  return {
    resolved: {
      binding,
      symbol: parts.length === 1 ? parts[0]!.symbol : mergePartials(parts.map((p) => p.symbol)),
      file: parts[0]!.file,
      files: [...new Set(parts.map((p) => p.file.path))],
      parts: parts.map(({ symbol, file }) => ({ symbol, file })),
    },
    diagnostics: [],
    searched,
  };
}

/**
 * Overload signatures and their implementation are one declaration: entries with the same file,
 * qualified name and `static`-ness form a group, the implementation (plain id) first. C#
 * overloads all have bodies, so each is a declaration of its own. Every other declaration is its
 * own group, also when it shares an id (C# partial parts in one file).
 */
function groupOverloads(entries: SymbolEntry[]): SymbolEntry[][] {
  const isImplementation = (e: SymbolEntry): boolean =>
    e.symbol.id === `${e.file.path}#${e.symbol.qualifiedName}`;
  const groups = new Map<string | SymbolEntry, SymbolEntry[]>();
  for (const entry of entries) {
    const { symbol, file } = entry;
    const callable = symbol.kind === "function" || symbol.kind === "method";
    const key = callable
      ? `${file.path}\0${symbol.qualifiedName}\0${symbol.modifiers.includes("static")}`
      : entry;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()].flatMap((group) =>
    group[0]!.file.lang !== "csharp"
      ? [[...group].sort((a, b) => Number(isImplementation(b)) - Number(isImplementation(a)))]
      : group.map((entry) => [entry]),
  );
}

/** C# partial parts as one type: members, bases, attributes and modifiers of every part. */
function mergePartials(parts: SymbolFact[]): SymbolFact {
  const [first, ...rest] = parts as [SymbolFact, ...SymbolFact[]];
  const merged: SymbolFact = {
    ...first,
    members: [...first.members],
    bases: [...first.bases],
    attributes: [...first.attributes],
    modifiers: [...first.modifiers],
  };
  for (const part of rest) {
    merged.members.push(...part.members);
    for (const base of part.bases) {
      if (!merged.bases.some((b) => b.text === base.text)) merged.bases.push(base);
    }
    merged.attributes.push(...part.attributes);
    for (const modifier of part.modifiers) {
      if (!merged.modifiers.includes(modifier)) merged.modifiers.push(modifier);
    }
    if (part.exported) merged.exported = true;
  }
  return merged;
}

/**
 * Up to 3 declarations of the right kind whose names are close to `name` (Damerau-Levenshtein),
 * the hinted files first.
 */
function closeNames(
  name: string,
  table: SymbolTable,
  kindOk: (s: SymbolFact) => boolean,
  langOk: (f: FileFacts) => boolean,
  inHint: (e: SymbolEntry) => boolean,
): SymbolEntry[] {
  const last = name.slice(name.lastIndexOf(".") + 1);
  const candidates = table.entries.filter((e) => kindOk(e.symbol) && langOk(e.file));
  const firstByName = (entries: SymbolEntry[]): Map<string, SymbolEntry> => {
    const map = new Map<string, SymbolEntry>();
    for (const e of entries) if (!map.has(e.symbol.name)) map.set(e.symbol.name, e);
    return map;
  };
  const hinted = firstByName(candidates.filter(inHint));
  const all = firstByName(candidates);
  const names = [
    ...didYouMean(last, [...hinted.keys()].sort(compareStrings)),
    ...didYouMean(last, [...all.keys()].sort(compareStrings)),
  ];
  return [...new Set(names)].slice(0, 3).map((n) => hinted.get(n) ?? all.get(n)!);
}
