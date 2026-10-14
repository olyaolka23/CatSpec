/**
 * Syntactic name and type matching (plan §D11.5, analysis F-5, ADR-002), shared by the binding
 * resolver and the rules: a name written in a spec matches a declaration when it is a segment-wise
 * suffix of the declaration's qualified name.
 */
import type { TypeRef } from "./facts.js";

/** True when `suffix` equals the last segments of `name`. */
export function isSegmentSuffix(suffix: readonly string[], name: readonly string[]): boolean {
  if (suffix.length === 0 || suffix.length > name.length) return false;
  const offset = name.length - suffix.length;
  return suffix.every((segment, i) => segment === name[offset + i]);
}

/**
 * True when the type found in code satisfies the expected one: the expected name is a
 * segment-wise suffix of the found name and the generic arguments match pairwise, recursively.
 * Types without a name match only by equal normalised text.
 */
export function typeMatches(expected: TypeRef, found: TypeRef): boolean {
  if (expected.name.length === 0 || found.name.length === 0) {
    return expected.name.length === found.name.length && expected.text === found.text;
  }
  return (
    isSegmentSuffix(expected.name, found.name) &&
    expected.args.length === found.args.length &&
    expected.args.every((arg, i) => typeMatches(arg, found.args[i]!))
  );
}

/**
 * True when a symbol's qualified name (`Outer.Inner.method`) ends with the expected name
 * (`Inner.method`), segment by segment: `Handler` doesn't match `MyHandler`.
 */
export const nameMatches = (expected: string, qualifiedName: string): boolean =>
  isSegmentSuffix(expected.split("."), qualifiedName.split("."));

const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * A matcher for a pattern in which `*` stands for any text, dots included: `console.*` matches
 * `console.log`, `IMessageHandler<*>` matches `IMessageHandler<UserUpdated>`. Without a `*` the
 * text must equal the pattern.
 */
export function wildcard(pattern: string): (text: string) => boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[^]*")}$`);
  return (text) => regex.test(text);
}

/**
 * True when a qualified name matches a pattern written in a spec: segment-wise suffix match
 * without `*`; with `*`, the pattern must match the name or the name without some leading
 * segments (`*Handler` matches `Handlers.UserHandler`).
 */
export function qualifiedNameMatches(pattern: string, qualifiedName: string): boolean {
  if (!pattern.includes("*")) return nameMatches(pattern, qualifiedName);
  const matches = wildcard(pattern);
  const segments = qualifiedName.split(".");
  return segments.some((_, i) => matches(segments.slice(i).join(".")));
}

/**
 * True when a type found in code matches a type pattern from a spec: `*` matches any text and the
 * pattern may omit leading namespace segments of the found type.
 */
export function typePatternMatches(pattern: string, found: TypeRef): boolean {
  const matches = wildcard(pattern.replace(/\s+/g, "").replace(/,/g, ", "));
  if (matches(found.text)) return true;
  const args = found.text.slice(found.name.join(".").length);
  return found.name.some((_, i) => matches(found.name.slice(i).join(".") + args));
}
