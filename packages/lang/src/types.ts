/**
 * Type and name normalisation (plan §D11.5, analysis F-5, PBI `type-normaliser`). Matching is
 * syntactic: a type written as `IHandler<Created>` matches `Contracts.IHandler<Events.Created>`
 * because each name is a segment-wise suffix of the other side's name.
 */
import type { TypeRef } from "@catspec/core";

const IDENTIFIER = /^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]*$/u;

/**
 * Removes whitespace except between two word characters (`keyof T` keeps its space), then writes
 * one space after each comma: `Map< string ,number >` becomes `Map<string, number>`.
 */
export const normalizeTypeText = (text: string): string =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ (?![\p{L}\p{N}_$])|(?<![\p{L}\p{N}_$]) /gu, "")
    .replace(/,/g, ", ");

/**
 * Parses type text such as `A.B<C.D, E>` into a `TypeRef`. A leading `global::` (C#) is dropped.
 * Text that isn't a (generic) qualified name, e.g. `string | null`, gives an empty `name` and keeps
 * the normalised text; adapters turn their own syntax (`T[]`, `T?`) into names before calling this.
 */
export function parseTypeRef(text: string): TypeRef {
  const normalized = normalizeTypeText(text).replace(/^global::/, "");
  const tokens = normalized.replace(/, /g, ",").match(/[^.<>,]+|[.<>,]/g) ?? [];
  let at = 0;

  const parse = (): TypeRef | undefined => {
    const name: string[] = [];
    for (;;) {
      const segment = tokens[at];
      if (segment === undefined || !IDENTIFIER.test(segment)) return undefined;
      name.push(segment);
      at++;
      if (tokens[at] !== ".") break;
      at++;
    }
    const args: TypeRef[] = [];
    if (tokens[at] === "<") {
      at++;
      for (;;) {
        const arg = parse();
        if (!arg) return undefined;
        args.push(arg);
        const next = tokens[at++];
        if (next === ">") break;
        if (next !== ",") return undefined;
      }
    }
    return { text: format(name, args), name, args };
  };

  const ref = parse();
  return ref && at === tokens.length ? ref : { text: normalized, name: [], args: [] };
}

const format = (name: string[], args: TypeRef[]): string =>
  name.join(".") + (args.length > 0 ? `<${args.map((arg) => arg.text).join(", ")}>` : "");

// Name and type matching moved to `@catspec/core`, which the rule engine needs; re-exported here.
export { isSegmentSuffix, nameMatches, typeMatches } from "@catspec/core";
