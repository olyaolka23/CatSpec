/**
 * The contract evaluator (plan §D5.3, §D11.5, analysis F-5), PBI `contract-evaluator`: checks a
 * resolved declaration against its binding: kind (in the resolver), export, base types,
 * attributes, constructor dependencies and members with their signatures. What syntax alone
 * can't decide is CS0220, never a failure (ADR-002). Every diagnostic names its contract item:
 * `binding:<id>` for the declaration, `binding:<id>.<member>` for each member.
 */
import { codeLocation, formatLocation, type SymbolTable } from "./codebase.js";
import { createDiagnostic, type Diagnostic, type DiagnosticCode } from "./diagnostics.js";
import type {
  AttributeFact,
  FileFacts,
  LanguageAdapter,
  ParamFact,
  SymbolFact,
  TypeRef,
} from "./facts.js";
import { isSegmentSuffix, typeMatches } from "./match.js";
import type { ResolvedBinding } from "./resolve.js";
import type { Member, MemberKind } from "./spec-schema.js";
import { specLocation, type Spec } from "./spec.js";
import { didYouMean, editDistance, listOf } from "./util.js";

export interface ContractContext {
  table: SymbolTable;
  adapter?: LanguageAdapter | undefined;
  /** `enforcement.unresolvable`: the severity of CS0220. */
  unresolvable: "warn" | "error";
}

/** Contract items of a binding: the declaration, then each member. */
export const bindingItems = (binding: { id: string; members: { name: string }[] }): string[] => [
  `binding:${binding.id}`,
  ...binding.members.map((m) => `binding:${binding.id}.${m.name}`),
];

const VISIBILITY = new Set(["public", "private", "protected", "internal"]);

/** Evaluates the contract of a resolved binding. */
export function evaluateContract(
  spec: Spec,
  resolved: ResolvedBinding,
  context: ContractContext,
): Diagnostic[] {
  const { binding, symbol, file } = resolved;
  const diagnostics: Diagnostic[] = [];
  const where = codeLocation(file.path, symbol.nameRange);
  /** The file a member is declared in: the file of its part, for a C# partial type. */
  const pathOf = (member: SymbolFact): string =>
    resolved.parts.find((p) => p.symbol.members.includes(member))?.file.path ?? file.path;
  const subject = `${symbol.kind} ${symbol.qualifiedName}`;
  const normalize = (text: string): TypeRef =>
    context.adapter?.normalizeType(text) ?? plainType(text);
  const report = (
    code: DiagnosticCode,
    path: (string | number)[],
    item: string,
    message: string,
    extra: Partial<Diagnostic> = {},
  ): void => {
    diagnostics.push(
      createDiagnostic(code, {
        spec: spec.id,
        specLocation: specLocation(spec.source, ["bindings", binding.index, ...path]),
        codeLocation: where,
        bindingId: binding.id,
        item,
        message,
        ...(code === "CS0220" ? { severity: unresolvableSeverity(context) } : {}),
        ...extra,
      }),
    );
  };
  const item = `binding:${binding.id}`;

  // exported: TypeScript `export`, C# `public`.
  if (binding.exported !== undefined) {
    const exported = symbol.exported === true || symbol.modifiers.includes("public");
    if (exported !== binding.exported) {
      report(
        "CS0208",
        ["exported"],
        item,
        `${subject} must ${binding.exported ? "" : "not "}be exported`,
        {
          expected: binding.exported ? "exported" : "not exported",
          actual: exported ? "exported" : "not exported",
          suggestions: [
            {
              message: binding.exported
                ? `export ${symbol.name} (TypeScript) or make it public (C#)`
                : `remove the export of ${symbol.name}, or set exported: true`,
            },
          ],
        },
      );
    }
  }

  // implements / extends: direct base types, by qualified-name suffix.
  const bases = symbol.bases.map((b) => ({
    base: b,
    variants: resolved.parts.flatMap((p) => baseVariants(b, p.file)),
  }));
  const foundBases = symbol.bases.length > 0 ? listOf(symbol.bases.map((b) => b.text)) : "none";
  const checkBase = (
    expectedText: string,
    path: (string | number)[],
    verb: string,
    candidates = bases,
  ): void => {
    const expected = normalize(expectedText);
    if (candidates.some(({ variants }) => variants.some((v) => typeMatches(expected, v)))) return;
    const unsure = candidates.filter(({ variants }) =>
      variants.some((v) => undecidableBase(v, context)),
    );
    if (unsure.length > 0) {
      report(
        "CS0220",
        path,
        item,
        `can't tell whether ${subject} ${verb} ${expected.text}: its base ${listOf(unsure.map((u) => u.base.text))} is a type alias or not a plain name`,
        {
          expected: expected.text,
          actual: symbol.bases.map((b) => b.text),
          suggestions: [{ message: `name ${expected.text} directly in the declaration` }],
        },
      );
      return;
    }
    report("CS0204", path, item, `${subject} does not ${verb} ${expected.text}`, {
      expected: expected.text,
      actual: symbol.bases.map((b) => b.text),
      suggestions: [
        {
          message: `found base types: ${foundBases}; add ${expected.text} to the declaration of ${symbol.name}, or update the spec`,
        },
      ],
    });
  };
  binding.implements?.forEach((t, i) => checkBase(t, ["implements", i], "implement"));
  // C# doesn't mark the base class in a base list. A class or record has at most one, first in
  // the base list of the part that declares it; a first base named like an interface (`IFoo`)
  // isn't one, and a struct has none. An interface extends every interface in its base list.
  const extendable =
    file.lang !== "csharp" || symbol.kind === "interface"
      ? bases
      : symbol.kind === "struct"
        ? []
        : bases.filter(
            ({ base }) =>
              resolved.parts.some((p) => p.symbol.bases[0]?.text === base.text) &&
              !/^I[A-Z]/.test(base.name.at(-1) ?? ""),
          );
  if (binding.extends !== undefined) {
    checkBase(binding.extends, ["extends"], "extend", extendable);
  }

  // attributes / decorators.
  binding.attributes?.forEach((text, i) => {
    if (symbol.attributes.some((a) => attributeMatches(text, a))) return;
    report("CS0206", ["attributes", i], item, `${subject} lacks attribute ${text}`, {
      expected: text,
      actual: symbol.attributes.map(attributeText),
      suggestions: [{ message: `add ${text} to ${symbol.name}` }],
    });
  });

  // constructor.requires: types a constructor must take (dependency injection).
  if (binding.constructorRequires && binding.constructorRequires.length > 0) {
    checkConstructor(binding.constructorRequires);
  }

  function checkConstructor(required: string[]): void {
    const path = ["constructor", "requires"];
    const ctors = symbol.members.filter((m) => m.kind === "constructor");
    if (ctors.length === 0) {
      if (symbol.bases.length > 0) {
        report(
          "CS0220",
          path,
          item,
          `can't tell whether ${subject} takes ${listOf(required)}: it has no constructor of its own and may inherit one from ${foundBases}`,
          {
            expected: required,
            suggestions: [{ message: `declare a constructor in ${symbol.name}` }],
          },
        );
        return;
      }
      required.forEach((type, i) =>
        report("CS0207", [...path, i], item, `${subject} has no constructor taking ${type}`, {
          expected: type,
          actual: "no constructor",
          suggestions: [{ message: `add a constructor to ${symbol.name} that takes ${type}` }],
        }),
      );
      return;
    }
    const scored = ctors.map((ctor) => {
      const params = ctor.params ?? [];
      const status = required.map((type) => {
        const expected = normalize(type);
        if (params.some((p) => p.type && typeMatches(expected, p.type))) return "ok";
        return params.some((p) => !p.type) ? "unsure" : "missing";
      });
      return { ctor, status, ok: status.filter((s) => s === "ok").length };
    });
    if (scored.some((s) => s.ok === required.length)) return;
    const best = scored.reduce((a, b) => (b.ok > a.ok ? b : a));
    const found = `constructor(${(best.ctor.params ?? []).map(paramText).join(", ")})`;
    best.status.forEach((status, i) => {
      if (status === "ok") return;
      const type = required[i]!;
      if (status === "unsure") {
        report(
          "CS0220",
          [...path, i],
          item,
          `can't tell whether ${subject} takes ${type}: ${found} has parameters without a type`,
          {
            expected: type,
            actual: found,
            suggestions: [{ message: "add type annotations to the constructor parameters" }],
          },
        );
      } else {
        report("CS0207", [...path, i], item, `${subject}: constructor dependency ${type} missing`, {
          codeLocation: codeLocation(pathOf(best.ctor), best.ctor.nameRange),
          expected: type,
          actual: found,
          suggestions: [
            { message: `add a parameter of type ${type} to the constructor of ${symbol.name}` },
          ],
        });
      }
    });
  }

  // Members.
  const claimed = new Set(binding.members.map((m) => m.name));
  binding.members.forEach((member, i) => {
    const memberItem = `binding:${binding.id}.${member.name}`;
    const path = ["members", i];
    const candidates = symbol.members.filter((m) =>
      member.kind === "constructor"
        ? m.kind === "constructor"
        : m.name === member.name && m.kind !== "constructor",
    );
    if (candidates.length === 0) {
      if (member.optional) return;
      const close = closeMembers(member, symbol, claimed);
      report(
        "CS0203",
        path,
        memberItem,
        `member ${member.name} missing in ${symbol.qualifiedName}`,
        {
          expected: memberText(member),
          actual: close.length > 0 ? close.map((c) => signatureText(c)) : "nothing",
          suggestions: [
            ...close.map((c) => ({
              message: `did you mean ${c.name}? (${formatLocation(pathOf(c), c.nameRange)})`,
            })),
            { message: `add ${member.name} to ${symbol.name}, or update the spec` },
          ],
        },
      );
      return;
    }
    const results = candidates.map((c) => ({
      candidate: c,
      ...compareMember(member, c, normalize, file),
    }));
    if (results.some((r) => r.mismatches.length === 0 && r.unsure.length === 0)) return;
    const best = results.reduce((a, b) =>
      b.mismatches.length + b.unsure.length < a.mismatches.length + a.unsure.length ? b : a,
    );
    const at = codeLocation(pathOf(best.candidate), best.candidate.nameRange);
    const found = signatureText(best.candidate);
    const visibility = best.mismatches.filter((m) => m.code === "CS0208");
    const signature = best.mismatches.filter((m) => m.code !== "CS0208");
    for (const group of [visibility, signature]) {
      if (group.length === 0) continue;
      const code = group[0]!.code;
      report(
        code,
        path,
        memberItem,
        `member ${member.name} ${code === "CS0208" ? "visibility" : code === "CS0206" ? "attributes" : "signature"} mismatch: ${group.map((m) => m.text).join("; ")}`,
        {
          codeLocation: at,
          expected: memberText(member),
          actual: found,
          suggestions: [
            { message: `change ${member.name} to ${memberText(member)}, or update the spec` },
          ],
        },
      );
    }
    if (best.mismatches.length === 0) {
      report(
        "CS0220",
        path,
        memberItem,
        `can't check member ${member.name} from syntax: ${best.unsure.join("; ")}`,
        {
          codeLocation: at,
          expected: memberText(member),
          actual: found,
          suggestions: [{ message: "write the types explicitly in the code" }],
        },
      );
    }
  });

  return diagnostics;
}

interface Mismatch {
  code: DiagnosticCode;
  text: string;
}

/** Differences between a member entry and one declaration of that name. */
function compareMember(
  member: Member,
  found: SymbolFact,
  normalize: (text: string) => TypeRef,
  file: FileFacts,
): { mismatches: Mismatch[]; unsure: string[] } {
  const mismatches: Mismatch[] = [];
  const unsure: string[] = [];
  if (member.kind && !kindMatches(member.kind, found.kind, file.lang)) {
    mismatches.push({ code: "CS0205", text: `kind: expected ${member.kind}, found ${found.kind}` });
  }
  if (member.params) {
    const params = found.params;
    if (!params) {
      mismatches.push({
        code: "CS0205",
        text: `parameters: expected (${member.params.join(", ")}), found a ${found.kind}`,
      });
    } else if (params.length !== member.params.length) {
      mismatches.push({
        code: "CS0205",
        text: `parameters: expected ${member.params.length}, found ${params.length}`,
      });
    } else {
      member.params.forEach((type, i) => {
        const param = params[i]!;
        if (type === "*") return;
        if (!param.type) {
          unsure.push(`parameter ${param.name} has no type`);
          return;
        }
        const expected = normalize(type);
        if (!typeMatches(expected, param.type)) {
          mismatches.push({
            code: "CS0205",
            text: `parameter ${i + 1} (${param.name}): expected ${expected.text}, found ${param.type.text}`,
          });
        }
      });
    }
  }
  if (member.returns !== undefined) {
    const expected = normalize(member.returns);
    if (!found.returns)
      unsure.push(
        `${found.name} has no declared ${found.kind === "property" ? "type" : "return type"}`,
      );
    else if (!typeMatches(expected, found.returns)) {
      mismatches.push({
        code: "CS0205",
        text: `returns: expected ${expected.text}, found ${found.returns.text}`,
      });
    }
  }
  for (const modifier of member.modifiers ?? []) {
    if (hasModifier(found, modifier, file.lang)) continue;
    mismatches.push({
      code: VISIBILITY.has(modifier) ? "CS0208" : "CS0205",
      text: `modifier ${modifier} missing`,
    });
  }
  for (const attribute of member.attributes ?? []) {
    if (found.attributes.some((a) => attributeMatches(attribute, a))) continue;
    mismatches.push({ code: "CS0206", text: `attribute ${attribute} missing` });
  }
  return { mismatches, unsure };
}

/** TypeScript has no fields apart from properties. */
const kindMatches = (expected: MemberKind, found: string, lang: string): boolean =>
  expected === found ||
  (lang === "typescript" &&
    (expected === "field" || expected === "property") &&
    found === "property");

/** A modifier on a declaration; TypeScript class members without one are public. */
function hasModifier(symbol: SymbolFact, modifier: string, lang: string): boolean {
  if (symbol.modifiers.includes(modifier)) return true;
  return (
    lang === "typescript" &&
    modifier === "public" &&
    !symbol.modifiers.some((m) => m === "private" || m === "protected")
  );
}

/**
 * Members of the declaration close to a missing member's name, of a compatible kind and not
 * required by another entry: by edit distance, else by a shared word (`checkToken` for
 * `validateToken`).
 */
function closeMembers(member: Member, symbol: SymbolFact, claimed: Set<string>): SymbolFact[] {
  const candidates = symbol.members.filter(
    (m) =>
      m.kind !== "constructor" &&
      !claimed.has(m.name) &&
      (!member.kind ||
        m.kind === member.kind ||
        (member.kind !== "method" && m.kind === "property")),
  );
  const byName = new Map<string, SymbolFact>();
  for (const c of candidates) if (!byName.has(c.name)) byName.set(c.name, c);
  let names = didYouMean(member.name, byName.keys());
  if (names.length === 0) {
    const words = new Set(wordsOf(member.name));
    names = [...byName.keys()]
      .filter((name) => wordsOf(name).some((w) => words.has(w)))
      .sort(
        (a, b) =>
          editDistance(member.name.toLowerCase(), a.toLowerCase()) -
          editDistance(member.name.toLowerCase(), b.toLowerCase()),
      )
      .slice(0, 3);
  }
  return names.map((n) => byName.get(n)!);
}

/** Lowercase words of an identifier of 3+ letters: `validateToken` → validate, token. */
const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_$-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);

/**
 * A base type as written and as resolved through the file's imports: `Base` imported as
 * `import { IHandler as Base }` is also `IHandler`; `ns.IHandler` from `import * as ns` is also
 * `IHandler`.
 */
function baseVariants(base: TypeRef, file: FileFacts): TypeRef[] {
  const variants = [base];
  const head = base.name[0];
  if (head === undefined) return variants;
  for (const imp of file.imports) {
    for (const imported of imp.names) {
      if ((imported.alias ?? imported.name) !== head) continue;
      if (imported.name === "*" && base.name.length > 1) {
        const name = base.name.slice(1);
        variants.push({ ...base, name, text: base.text.slice(head.length + 1) });
      } else if (imported.name !== "*" && imported.name !== "default" && imported.name !== head) {
        const name = [imported.name, ...base.name.slice(1)];
        variants.push({ ...base, name, text: imported.name + base.text.slice(head.length) });
      }
    }
  }
  return variants;
}

/** A base type syntax can't compare: not a plain name, or a type alias declared in the code. */
function undecidableBase(base: TypeRef, context: ContractContext): boolean {
  if (base.name.length === 0) return true;
  const declared = context.table.find(base.name.join("."));
  return declared.length > 0 && declared.every((e) => e.symbol.kind === "type");
}

const unresolvableSeverity = (context: ContractContext): "warning" | "error" =>
  context.unresolvable === "error" ? "error" : "warning";

/** A type reference from text without an adapter: only equal text matches. */
const plainType = (text: string): TypeRef => ({
  text: text.replace(/\s+/g, ""),
  name: [],
  args: [],
});

/** `HttpGet("users")` matches an attribute named `HttpGet`/`HttpGetAttribute` with that argument. */
export function attributeMatches(expected: string, found: AttributeFact): boolean {
  const match = /^\s*([^(]+?)\s*(?:\((.*)\))?\s*$/s.exec(expected);
  if (!match) return false;
  const name = match[1]!.replace(/Attribute$/, "").split(".");
  const foundName = found.name.replace(/Attribute$/, "").split(".");
  if (!isSegmentSuffix(name, foundName)) return false;
  if (match[2] === undefined) return true;
  const args = splitArgs(match[2]).map(normalizeArg);
  const foundArgs = found.args.map(normalizeArg);
  return args.length === foundArgs.length && args.every((a, i) => a === foundArgs[i]);
}

const normalizeArg = (arg: string): string => arg.replace(/\s+/g, "").replace(/'/g, '"');

/** Splits arguments at top-level commas. */
function splitArgs(text: string): string[] {
  if (text.trim() === "") return [];
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("([{<".includes(char)) depth++;
    else if (")]}>".includes(char)) depth--;
    else if (char === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  args.push(current);
  return args;
}

const attributeText = (a: AttributeFact): string =>
  a.args.length > 0 ? `${a.name}(${a.args.join(", ")})` : a.name;

const paramText = (p: ParamFact): string => (p.type ? `${p.name}: ${p.type.text}` : p.name);

/** `login(string, number): Promise<boolean>`, as a spec writes it. */
function memberText(member: Member): string {
  const params = member.params ? `(${member.params.join(", ")})` : "";
  const returns = member.returns ? `: ${member.returns}` : "";
  const modifiers =
    member.modifiers && member.modifiers.length > 0 ? `${member.modifiers.join(" ")} ` : "";
  return `${modifiers}${member.kind ? `${member.kind} ` : ""}${member.name}${params}${returns}`;
}

/** A declaration's signature: `method login(user: string): Promise<boolean>`. */
export function signatureText(symbol: SymbolFact): string {
  const modifiers = symbol.modifiers.length > 0 ? `${symbol.modifiers.join(" ")} ` : "";
  const params = symbol.params ? `(${symbol.params.map(paramText).join(", ")})` : "";
  const returns = symbol.returns ? `: ${symbol.returns.text}` : "";
  return `${modifiers}${symbol.kind} ${symbol.name}${params}${returns}`;
}
