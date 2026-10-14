/**
 * Turns a C# syntax tree into `FileFacts` (plan §D11.2, PBIs `csharp-declarations` and
 * `csharp-attributes-bases-imports`). Declarations come from a walk over the tree; `using`
 * directives and calls from queries. Declarations inside syntax errors are still found, so a broken
 * file yields partial facts.
 *
 * Namespaces aren't symbols: they qualify the names of the types in them, so the types of a file
 * are its top-level symbols (`Identity.Handlers.UserUpdatedHandler`). Modifiers are the ones
 * written in the code; C#'s implicit defaults (`private` members, `public` interface members) are
 * not added.
 */
import {
  LineIndex,
  type AttributeFact,
  type CallFact,
  type FileFacts,
  type ImportFact,
  type ParamFact,
  type Range,
  type SourceFile,
  type SymbolFact,
  type SymbolKind,
  type TypeRef,
} from "@catspec/core";
import { parseTypeRef, type Grammar, type Node } from "@catspec/lang";

import { CALLS, USINGS } from "./queries.js";
import { compact, typeRefOf, typeText } from "./types.js";

/** Type declarations and the symbol kind of each. */
const TYPE_DECLARATIONS: Readonly<Record<string, SymbolKind>> = {
  class_declaration: "class",
  struct_declaration: "struct",
  interface_declaration: "interface",
  record_declaration: "record",
  record_struct_declaration: "record",
  enum_declaration: "enum",
  delegate_declaration: "type",
};

interface Scope {
  /** Qualified name of the enclosing namespace or type, `""` at the top level. */
  prefix: string;
  members: SymbolFact[];
}

const qualify = (prefix: string, name: string): string => (prefix ? `${prefix}.${name}` : name);

/** Extracts the facts of `file` from its syntax tree. */
export function extractFacts(grammar: Grammar, rootNode: Node, file: SourceFile): FileFacts {
  const lines = new LineIndex(file.text);
  const rangeOf = (node: Node): Range => ({
    start: lines.position(node.startIndex),
    end: lines.position(node.endIndex),
  });

  const { imports, aliases } = usingsOf(grammar, rootNode, rangeOf);

  const attributesOf = (node: Node): AttributeFact[] =>
    node.namedChildren
      .filter((c): c is Node => c?.type === "attribute_list")
      .flatMap((list) => list.namedChildren.filter((c): c is Node => c?.type === "attribute"))
      .map((attribute) => {
        const name = attribute.childForFieldName("name");
        const args = attribute.namedChildren.find((c) => c?.type === "attribute_argument_list");
        return {
          name: compact(name?.text ?? attribute.text).replace(/^global::/, ""),
          args: (args?.namedChildren ?? [])
            .filter((a): a is Node => a?.type === "attribute_argument")
            .map((a) => a.text),
          range: rangeOf(attribute),
        };
      });

  const modifiersOf = (node: Node): string[] =>
    node.namedChildren.filter((c): c is Node => c?.type === "modifier").map((c) => c.text);

  /**
   * Parameters of a parameter list. A `params` array is not wrapped in a `parameter` node: its
   * `params` token, type and name are children of the list itself.
   */
  const paramsOf = (list: Node | null | undefined): ParamFact[] => {
    if (!list) return [];
    const params: ParamFact[] = [];
    let pending: { type?: TypeRef } | undefined;
    for (let i = 0; i < list.childCount; i++) {
      const child = list.child(i);
      if (!child) continue;
      if (child.type === "parameter") {
        const type = child.childForFieldName("type");
        const name = child.childForFieldName("name");
        params.push({
          name: name?.text ?? "",
          ...(type ? { type: typeRefOf(type) } : {}),
          modifiers: modifiersOf(child),
          ...(child.children.some((c) => c?.type === "=") ? { optional: true } : {}),
          attributes: attributesOf(child),
        });
      } else if (child.type === "params") {
        pending = {};
      } else if (pending) {
        const field = list.fieldNameForChild(i);
        if (field === "type") pending.type = typeRefOf(child);
        else if (field === "name") {
          params.push({
            name: child.text,
            ...(pending.type ? { type: pending.type } : {}),
            modifiers: ["params"],
            rest: true,
            attributes: [],
          });
          pending = undefined;
        }
      }
    }
    return params;
  };

  const typeParamsOf = (node: Node): string[] =>
    (node.childForFieldName("type_parameters")?.namedChildren ?? [])
      .filter((p): p is Node => p?.type === "type_parameter")
      .map((p) => p.childForFieldName("name")?.text ?? p.text);

  /** A base type, with a `using` alias of the same file replaced by what it names. */
  const baseRef = (node: Node): TypeRef => {
    const text = typeText(node);
    const head = /^[^.<]+/.exec(text)?.[0] ?? text;
    const target = aliases.get(head);
    return parseTypeRef(target === undefined ? text : target + text.slice(head.length));
  };

  /** The base list in source order; C# names the base class, if any, first. */
  const basesOf = (node: Node): TypeRef[] => {
    const list = node.namedChildren.find((c) => c?.type === "base_list");
    return (list?.namedChildren ?? [])
      .filter((c): c is Node => c !== null && c.type !== "argument_list")
      .map((c) =>
        c.type === "primary_constructor_base_type"
          ? (c.childForFieldName("type") ?? c.namedChildren[0]!)
          : c,
      )
      .map(baseRef);
  };

  const symbol = (
    scope: Scope,
    kind: SymbolKind,
    node: Node,
    nameNode: Node,
    extra: Partial<SymbolFact> = {},
  ): SymbolFact => {
    const name = nameNode.text;
    const qualifiedName = qualify(scope.prefix, name);
    const fact: SymbolFact = {
      id: `${file.path}#${qualifiedName}`,
      name,
      qualifiedName,
      kind,
      range: rangeOf(node),
      nameRange: rangeOf(nameNode),
      modifiers: [],
      attributes: [],
      bases: [],
      typeParams: [],
      members: [],
      ...extra,
    };
    scope.members.push(fact);
    return fact;
  };

  /** Fields and events declared as `int a, b;`: one symbol per variable. */
  const variables = (scope: Scope, kind: SymbolKind, member: Node): void => {
    const declaration = member.namedChildren.find((c) => c?.type === "variable_declaration");
    if (!declaration) return;
    const type = declaration.childForFieldName("type");
    for (const declarator of declaration.namedChildren) {
      if (declarator?.type !== "variable_declarator") continue;
      const name =
        declarator.childForFieldName("name") ??
        declarator.namedChildren.find((c) => c?.type === "identifier");
      if (!name) continue;
      symbol(scope, kind, member, name, {
        modifiers: modifiersOf(member),
        attributes: attributesOf(member),
        ...(type ? { returns: typeRefOf(type) } : {}),
      });
    }
  };

  const visitMembers = (body: Node, owner: SymbolFact): void => {
    const scope: Scope = { prefix: owner.qualifiedName, members: owner.members };
    for (const member of body.namedChildren) {
      if (!member) continue;
      if (member.type === "ERROR") {
        visitMembers(member, owner);
        continue;
      }
      if (member.type in TYPE_DECLARATIONS) {
        typeDeclaration(member, scope);
        continue;
      }
      const nameNode = member.childForFieldName("name");
      const common = () => ({ modifiers: modifiersOf(member), attributes: attributesOf(member) });
      switch (member.type) {
        case "method_declaration": {
          if (!nameNode) break;
          const returns = member.childForFieldName("returns") ?? member.childForFieldName("type");
          symbol(scope, "method", member, nameNode, {
            ...common(),
            typeParams: typeParamsOf(member),
            params: paramsOf(member.childForFieldName("parameters")),
            ...(returns ? { returns: typeRefOf(returns) } : {}),
          });
          break;
        }
        case "constructor_declaration": {
          if (!nameNode) break;
          symbol(scope, "constructor", member, nameNode, {
            ...common(),
            params: paramsOf(member.childForFieldName("parameters")),
          });
          break;
        }
        case "property_declaration":
        case "event_declaration": {
          if (!nameNode) break;
          const type = member.childForFieldName("type");
          symbol(
            scope,
            member.type === "event_declaration" ? "event" : "property",
            member,
            nameNode,
            {
              ...common(),
              ...(type ? { returns: typeRefOf(type) } : {}),
            },
          );
          break;
        }
        case "field_declaration":
          variables(scope, "field", member);
          break;
        case "event_field_declaration":
          variables(scope, "event", member);
          break;
        default:
          // Operators, conversion operators, indexers and finalizers have no name to bind.
          break;
      }
    }
  };

  const typeDeclaration = (node: Node, scope: Scope): void => {
    const kind = TYPE_DECLARATIONS[node.type]!;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const modifiers = modifiersOf(node);
    if (kind === "type") {
      // A delegate: a named method signature.
      const returns = node.childForFieldName("type") ?? node.childForFieldName("returns");
      symbol(scope, kind, node, nameNode, {
        modifiers,
        attributes: attributesOf(node),
        typeParams: typeParamsOf(node),
        params: paramsOf(node.childForFieldName("parameters")),
        ...(returns ? { returns: typeRefOf(returns) } : {}),
      });
      return;
    }
    const fact = symbol(scope, kind, node, nameNode, {
      modifiers,
      attributes: attributesOf(node),
      bases: basesOf(node),
      typeParams: typeParamsOf(node),
      ...(modifiers.includes("partial") ? { partial: true } : {}),
    });
    const members: Scope = { prefix: fact.qualifiedName, members: fact.members };

    // A primary constructor (C# 12 classes and structs, records): `class Handler(ILogger log)`.
    const primary = node.namedChildren.find((c) => c?.type === "parameter_list");
    const primaryParams = primary ? paramsOf(primary) : [];
    if (primary) {
      symbol(members, "constructor", primary, nameNode, { params: primaryParams });
    }

    const body = node.childForFieldName("body");
    if (kind === "enum") {
      for (const member of body?.namedChildren ?? []) {
        const name = member?.type === "enum_member_declaration" && member.childForFieldName("name");
        if (name) symbol(members, "field", member, name, { attributes: attributesOf(member) });
      }
    } else if (body?.type === "declaration_list") {
      visitMembers(body, fact);
    }

    // A record's positional parameters are also public properties, unless the body declares them.
    if (kind === "record" && primary) {
      primary.namedChildren
        .filter((p): p is Node => p?.type === "parameter")
        .forEach((param, i) => {
          const name = param.childForFieldName("name");
          const fact = primaryParams[i];
          if (!name || !fact || members.members.some((m) => m.name === fact.name)) return;
          symbol(members, "property", param, name, {
            modifiers: ["public"],
            attributes: fact.attributes,
            ...(fact.type ? { returns: fact.type } : {}),
          });
        });
    }
  };

  /** Declarations of a compilation unit, namespace body or syntax error. */
  const visit = (node: Node, scope: Scope): void => {
    let current = scope;
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type in TYPE_DECLARATIONS) {
        typeDeclaration(child, current);
        continue;
      }
      switch (child.type) {
        case "namespace_declaration": {
          const name = child.childForFieldName("name");
          const body = child.childForFieldName("body");
          if (name && body) {
            visit(body, {
              prefix: qualify(current.prefix, namespaceName(name)),
              members: scope.members,
            });
          }
          break;
        }
        case "file_scoped_namespace_declaration": {
          // `namespace A.B;` qualifies every declaration after it in the file.
          const name = child.childForFieldName("name");
          if (!name) break;
          current = { prefix: qualify(scope.prefix, namespaceName(name)), members: scope.members };
          visit(child, current);
          break;
        }
        case "ERROR":
        case "declaration_list":
          visit(child, current);
          break;
        default:
          break;
      }
    }
  };

  const symbols: SymbolFact[] = [];
  visit(rootNode, { prefix: "", members: symbols });
  disambiguateOverloads(symbols);

  return {
    path: file.path,
    blobSha: file.blobSha,
    lang: "csharp",
    symbols,
    imports,
    calls: callsOf(grammar, rootNode, symbols, rangeOf),
    parseErrors: parseErrorsOf(rootNode).map((node) => rangeOf(node)),
  };
}

/** A namespace name as written, without whitespace and `global::`. */
const namespaceName = (node: Node): string => compact(node.text).replace(/^global::/, "");

/**
 * `using` directives as imports: the namespace or type as written, without `global::`. An alias
 * (`using Handler = Contracts.IMessageHandler<UserUpdatedEvent>;`) is the import of everything
 * named by its target, under the alias (`*` as `Handler`), and goes into the file's alias map with
 * the normalised target type.
 */
function usingsOf(
  grammar: Grammar,
  root: Node,
  rangeOf: (node: Node) => Range,
): { imports: ImportFact[]; aliases: Map<string, string> } {
  const imports: ImportFact[] = [];
  const aliases = new Map<string, string>();
  const query = grammar.query(USINGS.source, USINGS.captures);
  for (const { node } of query.captures(root)) {
    // `using Alias = Target;`: the alias is the `name` field; the target is the last named child.
    const alias = node.childForFieldName("name")?.text;
    const target = node.namedChildren.filter((c): c is Node => c !== null).at(-1);
    if (!target) continue;
    if (alias) aliases.set(alias, typeText(target));
    imports.push({
      module: compact(target.text).replace(/^global::/, ""),
      kind: "static",
      names: alias ? [{ name: "*", alias }] : [],
      range: rangeOf(node),
    });
  }
  return { imports, aliases };
}

/**
 * Overloads: when a type declares a method (or constructor) name more than once, every
 * declaration gets `(${arity})` appended to its id, plus `#${n}` (1-based, in source order) when
 * several have the same arity. C# overloads all have bodies, so none of them keeps the plain id.
 */
function disambiguateOverloads(symbols: SymbolFact[]): void {
  const groups = new Map<string, SymbolFact[]>();
  for (const fact of symbols) {
    if (fact.kind !== "method" && fact.kind !== "constructor") continue;
    groups.set(fact.qualifiedName, [...(groups.get(fact.qualifiedName) ?? []), fact]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const byArity = new Map<number, SymbolFact[]>();
    for (const fact of group) {
      const arity = fact.params?.length ?? 0;
      byArity.set(arity, [...(byArity.get(arity) ?? []), fact]);
    }
    for (const [arity, same] of byArity) {
      same.forEach((fact, i) => {
        fact.id = `${fact.id}(${arity})${same.length > 1 ? `#${i + 1}` : ""}`;
      });
    }
  }
  for (const fact of symbols) disambiguateOverloads(fact.members);
}

function callsOf(
  grammar: Grammar,
  root: Node,
  symbols: SymbolFact[],
  rangeOf: (node: Node) => Range,
): CallFact[] {
  const flat: SymbolFact[] = [];
  const flatten = (facts: SymbolFact[]): void => {
    for (const fact of facts) {
      flat.push(fact);
      flatten(fact.members);
    }
  };
  flatten(symbols);

  const calls: CallFact[] = [];
  const query = grammar.query(CALLS.source, CALLS.captures);
  for (const { name, node } of query.captures(root)) {
    if (name !== "callee") continue;
    const range = rangeOf(node.parent!);
    const enclosing = flat
      .filter((fact) => contains(fact.range, range))
      .reduce<SymbolFact | undefined>(
        (inner, fact) => (!inner || contains(inner.range, fact.range) ? fact : inner),
        undefined,
      );
    calls.push({
      callee: compact(node.text),
      ...(enclosing ? { enclosing: enclosing.id } : {}),
      range,
    });
  }
  return calls;
}

/** Missing nodes and `ERROR` nodes, outermost only. */
function parseErrorsOf(root: Node): Node[] {
  const errors: Node[] = [];
  const walk = (node: Node): void => {
    if (node.isMissing || node.isError) {
      errors.push(node);
      return;
    }
    if (!node.hasError) return;
    for (const child of node.children) if (child) walk(child);
  };
  walk(root);
  return errors;
}

const comparePositions = (a: Range["start"], b: Range["start"]): number =>
  a.line - b.line || a.column - b.column;

/** True when `outer` contains `inner`. */
const contains = (outer: Range, inner: Range): boolean =>
  comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
