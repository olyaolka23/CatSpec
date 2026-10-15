/**
 * C# type normalisation (plan §D11.5, analysis F-5, PBI `csharp-partials-and-types`). Equivalent
 * spellings get the same text, so the language-independent matcher compares them by name:
 *
 * - `global::` and a leading `System.` namespace are dropped: `global::System.String` → `String`;
 * - keyword types become their .NET names: `string` → `String`, `int` → `Int32`;
 * - `T?` becomes `Nullable<T>`, also for reference types (syntax can't tell them apart);
 * - `T[]` becomes `Array<T>`; tuples `(int a, string b)` become `ValueTuple<Int32, String>`;
 * - generic arguments are normalised the same way, so arity is part of the match.
 *
 * Arrays of more than one dimension, pointers and function pointers keep their text.
 */
import type { TypeRef } from "@catspec/core";
import { parseTypeRef, type Node } from "@catspec/lang";

/** Keyword types and their .NET names, without the `System.` namespace. */
const KEYWORD_TYPES: Readonly<Record<string, string>> = {
  bool: "Boolean",
  byte: "Byte",
  sbyte: "SByte",
  char: "Char",
  decimal: "Decimal",
  double: "Double",
  float: "Single",
  int: "Int32",
  uint: "UInt32",
  nint: "IntPtr",
  nuint: "UIntPtr",
  long: "Int64",
  ulong: "UInt64",
  short: "Int16",
  ushort: "UInt16",
  object: "Object",
  string: "String",
};

/**
 * The type a `using` alias in scope at `at` names, as normalised text; undefined when `name` is no
 * alias there.
 */
export type AliasResolver = (name: string, at: Node) => string | undefined;

/** The normalised `TypeRef` of a type node. */
export const typeRefOf = (node: Node, alias?: AliasResolver): TypeRef =>
  parseTypeRef(typeText(node, alias));

/** True when `node` is the right-hand name of a qualified name (`B` in `A.B`, `X` in `global::X`). */
const isQualifiedPart = (node: Node): boolean => {
  const parent = node.parent;
  return (
    (parent?.type === "qualified_name" || parent?.type === "alias_qualified_name") &&
    parent.childForFieldName("name")?.id === node.id
  );
};

/**
 * The normalised text of a type node. With `alias`, a `using` alias at the start of the type
 * (`Log`, `Ns.IThing`) or of a generic argument is replaced by what it names.
 */
export function typeText(node: Node, alias?: AliasResolver): string {
  const text = (child: Node): string => typeText(child, alias);
  switch (node.type) {
    case "predefined_type":
      return KEYWORD_TYPES[node.text] ?? node.text;
    case "identifier":
      return (!isQualifiedPart(node) && alias?.(node.text, node)) || node.text;
    case "alias_qualified_name": {
      // `global::X` is X; another extern alias stays part of the name's text.
      const prefix = node.childForFieldName("alias");
      const name = node.childForFieldName("name");
      if (!name) return compact(node.text);
      return prefix?.text === "global"
        ? text(name)
        : `${compact(prefix?.text ?? "")}::${text(name)}`;
    }
    case "qualified_name": {
      const qualifier = node.childForFieldName("qualifier");
      const name = node.childForFieldName("name");
      if (!qualifier || !name) return compact(node.text);
      const left = text(qualifier);
      // The qualifier of a qualifier is the leftmost part, so only a leading `System` is dropped.
      return left === "System" ? text(name) : `${left}.${text(name)}`;
    }
    case "generic_name": {
      const name = node.namedChildren.find((c) => c?.type === "identifier");
      const args = node.namedChildren.find((c) => c?.type === "type_argument_list");
      const list = (args?.namedChildren ?? []).filter((a): a is Node => a !== null);
      return `${name?.text ?? ""}<${list.map(text).join(", ")}>`;
    }
    case "nullable_type": {
      const inner = node.childForFieldName("type") ?? node.namedChildren[0];
      return inner ? `Nullable<${text(inner)}>` : compact(node.text);
    }
    case "array_type": {
      const element = node.childForFieldName("type");
      const rank = node.childForFieldName("rank");
      const dimensions = (rank?.text.match(/,/g)?.length ?? 0) + 1;
      if (!element) return compact(node.text);
      return dimensions === 1
        ? `Array<${text(element)}>`
        : `${text(element)}[${",".repeat(dimensions - 1)}]`;
    }
    case "tuple_type": {
      const elements = node.namedChildren
        .filter((c): c is Node => c?.type === "tuple_element")
        .map((element) => element.childForFieldName("type"))
        .filter((t): t is Node => t !== null);
      return `ValueTuple<${elements.map(text).join(", ")}>`;
    }
    default:
      return compact(node.text);
  }
}

/** Removes all whitespace: `Foo . Bar` → `Foo.Bar`. */
export const compact = (text: string): string => text.replace(/\s+/g, "");
