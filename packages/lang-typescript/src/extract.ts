/**
 * Turns a TypeScript/TSX syntax tree into `FileFacts` (plan §D11.2, PBI `typescript-adapter`).
 * Declarations come from a walk over the tree; imports and calls from queries. Declarations
 * inside syntax errors are still found, so a broken file yields partial facts.
 */
import {
  LineIndex,
  type AttributeFact,
  type CallFact,
  type FileFacts,
  type ImportFact,
  type ImportedName,
  type ParamFact,
  type Range,
  type SourceFile,
  type SymbolFact,
  type SymbolKind,
  type TypeRef,
} from "@catspec/core";
import { parseTypeRef, type Grammar, type Node } from "@catspec/lang";

import { CALLS, MODULE_STATEMENTS } from "./queries.js";

/** Normalises a type node: `T[]` and `readonly T[]` become `Array<T>`, whitespace is canonical. */
export function typeRefOf(node: Node): TypeRef {
  return parseTypeRef(typeText(node));
}

function typeText(node: Node): string {
  switch (node.type) {
    case "type_annotation":
    case "parenthesized_type": {
      const inner = node.namedChildren[0];
      if (!inner) return node.text;
      return node.type === "parenthesized_type" && inner.type !== "array_type"
        ? `(${typeText(inner)})`
        : typeText(inner);
    }
    case "array_type":
      return `Array<${typeText(node.namedChildren[0]!)}>`;
    case "readonly_type": {
      const inner = node.namedChildren[0];
      return inner?.type === "array_type" ? typeText(inner) : spliceChildren(node);
    }
    case "generic_type": {
      const name = node.childForFieldName("name");
      const args = node.childForFieldName("type_arguments")?.namedChildren ?? [];
      return `${name ? typeText(name) : ""}<${args.map((a) => typeText(a!)).join(", ")}>`;
    }
    default:
      return spliceChildren(node);
  }
}

/** The node's text with each named child replaced by its normalised text. */
function spliceChildren(node: Node): string {
  let text = "";
  let at = node.startIndex;
  for (const child of node.namedChildren) {
    if (!child) continue;
    text += node.text.slice(at - node.startIndex, child.startIndex - node.startIndex);
    text += child.type === "type_annotation" ? `: ${typeText(child)}` : typeText(child);
    at = child.endIndex;
  }
  text += node.text.slice(at - node.startIndex);
  return text;
}

const KEYWORD_MODIFIERS = new Set([
  "static",
  "async",
  "abstract",
  "readonly",
  "declare",
  "get",
  "set",
  "const",
]);

/** Nodes whose children may be declarations of the same scope. */
const CONTAINERS = new Set([
  "program",
  "ERROR",
  "export_statement",
  "ambient_declaration",
  "expression_statement",
]);

interface Scope {
  /** Qualified name of the enclosing declaration, `""` at the top level. */
  prefix: string;
  members: SymbolFact[];
}

/** Extracts the facts of `file` from its syntax tree. */
export function extractFacts(grammar: Grammar, rootNode: Node, file: SourceFile): FileFacts {
  const lines = new LineIndex(file.text);
  const rangeOf = (node: Node): Range => ({
    start: lines.position(node.startIndex),
    end: lines.position(node.endIndex),
  });
  const idOf = (qualifiedName: string): string => `${file.path}#${qualifiedName}`;

  const attributesOf = (decorators: Node[]): AttributeFact[] =>
    decorators.map((decorator) => {
      const expression = decorator.namedChildren[0]!;
      const call = expression.type === "call_expression";
      const callee = call ? expression.childForFieldName("function")! : expression;
      const args = call ? (expression.childForFieldName("arguments")?.namedChildren ?? []) : [];
      return {
        name: compact(callee.text),
        args: args.map((arg) => arg!.text),
        range: rangeOf(decorator),
      };
    });

  const modifiersOf = (node: Node): string[] => {
    const modifiers: string[] = [];
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === "accessibility_modifier") modifiers.push(child.text);
      else if (child.type === "override_modifier") modifiers.push("override");
      else if (!child.isNamed && KEYWORD_MODIFIERS.has(child.type)) modifiers.push(child.type);
      else if (!child.isNamed && child.type === "*") modifiers.push("generator");
      else if (!child.isNamed && child.type === "?") modifiers.push("optional");
    }
    return modifiers;
  };

  const paramsOf = (node: Node | null): ParamFact[] =>
    (node?.namedChildren ?? [])
      .filter(
        (p): p is Node =>
          (p?.type === "required_parameter" || p?.type === "optional_parameter") &&
          // A `this` parameter only types `this`; it isn't part of the call signature.
          p.childForFieldName("pattern")?.type !== "this",
      )
      .map((param) => {
        const pattern = param.childForFieldName("pattern");
        const rest = pattern?.type === "rest_pattern";
        const name = rest ? pattern.namedChildren[0]!.text : (pattern?.text ?? param.text);
        const type = param.childForFieldName("type");
        const modifiers = modifiersOf(param).filter((m) => m !== "optional");
        return {
          name,
          ...(type ? { type: typeRefOf(type) } : {}),
          modifiers,
          ...(param.type === "optional_parameter" ? { optional: true } : {}),
          ...(rest ? { rest: true } : {}),
          attributes: attributesOf(
            param.namedChildren.filter((c): c is Node => c?.type === "decorator"),
          ),
        };
      });

  const typeParamsOf = (node: Node): string[] =>
    (node.childForFieldName("type_parameters")?.namedChildren ?? []).map(
      (p) => p!.childForFieldName("name")?.text ?? p!.text,
    );

  const basesOf = (node: Node): TypeRef[] => {
    const bases: TypeRef[] = [];
    for (const clause of node.namedChildren) {
      if (clause?.type === "class_heritage") {
        for (const part of clause.namedChildren) {
          if (part?.type === "extends_clause") {
            const value = part.childForFieldName("value");
            const args = part.childForFieldName("type_arguments");
            if (value) {
              const argText = args
                ? `<${args.namedChildren.map((a) => typeText(a!)).join(", ")}>`
                : "";
              bases.push(parseTypeRef(compact(value.text) + argText));
            }
          } else if (part?.type === "implements_clause") {
            bases.push(...part.namedChildren.map((t) => typeRefOf(t!)));
          }
        }
      } else if (clause?.type === "extends_type_clause") {
        bases.push(...clause.namedChildren.map((t) => typeRefOf(t!)));
      }
    }
    return bases;
  };

  /** The range of `node`, starting at its first decorator when it has decorators. */
  const decoratedRange = (node: Node, decorators: Node[]): Range => {
    const first = decorators[0];
    return first && first.startIndex < node.startIndex
      ? { start: lines.position(first.startIndex), end: lines.position(node.endIndex) }
      : rangeOf(node);
  };

  /** Callables with a body; the others are overload signatures or declarations. */
  const implementations = new Set<SymbolFact>();
  /** Top-level `const f = () => …` that become symbols only if `export { f }` exports them. */
  const exportCandidates = new Set<SymbolFact>();

  const symbol = (
    scope: Scope,
    kind: SymbolKind,
    node: Node,
    nameNode: Node,
    extra: Partial<SymbolFact> = {},
  ): SymbolFact => {
    const name = nameNode.type === "string" ? stringValue(nameNode) : nameNode.text;
    const qualifiedName = scope.prefix ? `${scope.prefix}.${name}` : name;
    const fact: SymbolFact = {
      id: idOf(qualifiedName),
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

  /** Methods, functions and constructors with their parameters and return type. */
  const callable = (
    scope: Scope,
    kind: SymbolKind,
    node: Node,
    nameNode: Node,
    extra: Partial<SymbolFact>,
    signature: Node = node,
  ): SymbolFact => {
    const returnType = signature.childForFieldName("return_type");
    const fact = symbol(scope, kind, node, nameNode, {
      typeParams: typeParamsOf(signature),
      params: paramsOf(signature.childForFieldName("parameters")),
      ...(returnType ? { returns: typeRefOf(returnType) } : {}),
      ...extra,
    });
    if (signature.childForFieldName("body")) implementations.add(fact);
    return fact;
  };

  /** Members of a class or interface body; decorators precede the member they decorate. */
  const visitMembers = (body: Node, owner: SymbolFact): void => {
    const scope: Scope = { prefix: owner.qualifiedName, members: owner.members };
    let decorators: Node[] = [];
    for (const member of body.namedChildren) {
      if (!member) continue;
      if (member.type === "decorator") {
        decorators.push(member);
        continue;
      }
      const memberDecorators = [
        ...decorators,
        ...member.namedChildren.filter((c): c is Node => c?.type === "decorator"),
      ];
      const attributes = attributesOf(memberDecorators);
      const range = decoratedRange(member, memberDecorators);
      decorators = [];
      const nameNode = member.childForFieldName("name");
      if (!nameNode) continue;
      const modifiers = modifiersOf(member);
      switch (member.type) {
        case "method_definition":
        case "method_signature":
        case "abstract_method_signature": {
          const accessor = modifiers.find((m) => m === "get" || m === "set");
          if (accessor) {
            const existing = owner.members.find(
              (m) => m.kind === "property" && m.name === nameNode.text,
            );
            if (existing) {
              existing.modifiers.push(accessor);
              existing.attributes.push(...attributes);
              continue;
            }
            const returnType = member.childForFieldName("return_type");
            const setterParam = paramsOf(member.childForFieldName("parameters"))[0]?.type;
            const type = returnType ? typeRefOf(returnType) : setterParam;
            symbol(scope, "property", member, nameNode, {
              modifiers,
              attributes,
              range,
              ...(type ? { returns: type } : {}),
            });
            continue;
          }
          const kind = nameNode.text === "constructor" ? "constructor" : "method";
          const fact = callable(scope, kind, member, nameNode, { modifiers, attributes, range });
          if (kind === "constructor") {
            for (const [i, param] of (fact.params ?? []).entries()) {
              if (!param.modifiers.some((m) => PARAMETER_PROPERTY.has(m))) continue;
              const paramNode = member
                .childForFieldName("parameters")!
                .namedChildren.filter(
                  (p) => p?.type === "required_parameter" || p?.type === "optional_parameter",
                )[i]!;
              symbol(scope, "property", paramNode, paramNode.childForFieldName("pattern")!, {
                modifiers: [...param.modifiers, ...(param.optional ? ["optional"] : [])],
                attributes: param.attributes,
                ...(param.type ? { returns: param.type } : {}),
              });
            }
          }
          break;
        }
        case "public_field_definition":
        case "property_signature": {
          const type = member.childForFieldName("type");
          symbol(scope, "property", member, nameNode, {
            modifiers,
            attributes,
            range,
            ...(type ? { returns: typeRefOf(type) } : {}),
          });
          break;
        }
        default:
          break;
      }
    }
  };

  const visit = (node: Node, scope: Scope): void => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (CONTAINERS.has(child.type)) {
        visit(child, scope);
        continue;
      }
      declaration(child, scope);
    }
  };

  const declaration = (node: Node, scope: Scope): void => {
    const parent = node.parent;
    const exportStatement = parent?.type === "export_statement" ? parent : undefined;
    // Inside a syntax error, `export` is a token of its own before the declaration.
    const before = parent?.type === "ERROR" ? node.previousSibling : null;
    const defaultInError =
      before?.type === "default" && trailingExport(before.previousSibling) !== undefined;
    const exportedInError = trailingExport(before) !== undefined || defaultInError;
    // `declare` and `default` come from the statement around the declaration.
    const exportModifiers = [
      ...(parent?.type === "ambient_declaration" ? ["declare"] : []),
      ...(exportStatement?.children.some((c) => c?.type === "default") || defaultInError
        ? ["default"]
        : []),
    ];
    const exported = exportStatement || exportedInError ? { exported: true } : {};
    const outerDecorators =
      exportStatement?.namedChildren.filter((c): c is Node => c?.type === "decorator") ?? [];
    const nameNode = node.childForFieldName("name");

    switch (node.type) {
      case "class_declaration":
      case "abstract_class_declaration":
      case "class": {
        // A `class` node is a class expression; only one inside a syntax error is a declaration.
        if (!nameNode || (node.type === "class" && parent?.type !== "ERROR")) return;
        const decorators = [
          ...outerDecorators,
          ...node.namedChildren.filter((c): c is Node => c?.type === "decorator"),
        ];
        const fact = symbol(scope, "class", node, nameNode, {
          modifiers: [...modifiersOf(node), ...exportModifiers],
          attributes: attributesOf(decorators),
          range: decoratedRange(node, decorators),
          bases: basesOf(node),
          typeParams: typeParamsOf(node),
          ...exported,
        });
        const body = node.childForFieldName("body");
        if (body) visitMembers(body, fact);
        return;
      }
      case "interface_declaration": {
        if (!nameNode) return;
        const fact = symbol(scope, "interface", node, nameNode, {
          modifiers: exportModifiers,
          bases: basesOf(node),
          typeParams: typeParamsOf(node),
          ...exported,
        });
        const body = node.childForFieldName("body");
        if (body) visitMembers(body, fact);
        return;
      }
      case "type_alias_declaration": {
        if (!nameNode) return;
        symbol(scope, "type", node, nameNode, {
          modifiers: exportModifiers,
          typeParams: typeParamsOf(node),
          ...exported,
        });
        return;
      }
      case "enum_declaration": {
        if (!nameNode) return;
        const fact = symbol(scope, "enum", node, nameNode, {
          modifiers: [...modifiersOf(node), ...exportModifiers],
          ...exported,
        });
        const members: Scope = { prefix: fact.qualifiedName, members: fact.members };
        for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
          const name =
            member?.type === "enum_assignment" ? member.childForFieldName("name") : member;
          if (member && name && name.type === "property_identifier") {
            symbol(members, "field", member, name);
          }
        }
        return;
      }
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        if (!nameNode) return;
        callable(scope, "function", node, nameNode, {
          modifiers: [...modifiersOf(node), ...exportModifiers],
          ...exported,
        });
        return;
      }
      case "lexical_declaration": {
        // Exported `const f = () => …` and `const f = function () {…}` are functions, also when
        // a later `export { f }` exports them.
        const exportedHere = exportStatement !== undefined || exportedInError;
        if (!exportedHere && scope.prefix !== "") return;
        for (const declarator of node.namedChildren) {
          const value = declarator?.childForFieldName("value");
          const name = declarator?.childForFieldName("name");
          if (!value || !name || name.type !== "identifier") continue;
          if (value.type !== "arrow_function" && value.type !== "function_expression") continue;
          const fact = callable(
            scope,
            "function",
            declarator!,
            name,
            { modifiers: modifiersOf(value), ...(exportedHere ? { exported: true } : {}) },
            value,
          );
          if (!exportedHere) exportCandidates.add(fact);
        }
        return;
      }
      case "internal_module":
      case "module": {
        if (!nameNode) return;
        const fact = symbol(scope, "module", node, nameNode, {
          modifiers: exportModifiers,
          ...exported,
        });
        const body = node.childForFieldName("body");
        if (body) visit(body, { prefix: fact.qualifiedName, members: fact.members });
        return;
      }
      default:
        return;
    }
  };

  const symbols: SymbolFact[] = [];
  visit(rootNode, { prefix: "", members: symbols });
  markLocalExports(rootNode, symbols);
  const kept = symbols.filter((fact) => !exportCandidates.has(fact) || fact.exported);
  symbols.splice(0, symbols.length, ...kept);
  disambiguateOverloads(symbols, implementations);

  return {
    path: file.path,
    blobSha: file.blobSha,
    lang: "typescript",
    symbols,
    imports: importsOf(grammar, rootNode, rangeOf),
    calls: callsOf(grammar, rootNode, symbols, rangeOf),
    parseErrors: parseErrorsOf(rootNode).map(([start, end]) => ({
      start: lines.position(start),
      end: lines.position(end),
    })),
  };
}

/** Constructor parameter modifiers that make a parameter a property. */
const PARAMETER_PROPERTY = new Set(["public", "private", "protected", "readonly", "override"]);

/** Removes all whitespace: `this . repo\n.save` → `this.repo.save`. */
const compact = (text: string): string => text.replace(/\s+/g, "");

/** The content of a string literal node. */
const stringValue = (node: Node): string =>
  node.namedChildren.find((c) => c?.type === "string_fragment")?.text ?? "";

/** Marks top-level symbols named in `export { A, B as C }` and `export default A`. */
function markLocalExports(root: Node, symbols: SymbolFact[]): void {
  const statements = [root, ...root.descendantsOfType("ERROR")].flatMap((container) =>
    (container?.namedChildren ?? []).filter((c): c is Node => c?.type === "export_statement"),
  );
  for (const statement of statements) {
    if (statement.childForFieldName("source")) continue;
    const names = statement.namedChildren
      .filter((c): c is Node => c?.type === "export_clause")
      .flatMap((clause) => clause.namedChildren.map((s) => s?.childForFieldName("name")?.text));
    const value = statement.childForFieldName("value");
    if (value?.type === "identifier") names.push(value.text);
    for (const name of names) {
      for (const fact of symbols) {
        if (fact.name === name) fact.exported = true;
      }
    }
  }
}

/**
 * Overloads: when a scope declares a function or method more than once (a static and an
 * instance method of the same name are different members), the declarations without a body get
 * `(${arity})` appended to their id, plus `#${n}` (1-based, in source order) when several have the
 * same arity; the implementation, the one with a body, keeps the plain id.
 */
function disambiguateOverloads(symbols: SymbolFact[], implementations: Set<SymbolFact>): void {
  const groups = new Map<string, SymbolFact[]>();
  for (const fact of symbols) {
    if (fact.kind !== "function" && fact.kind !== "method") continue;
    const key = `${fact.modifiers.includes("static") ? "static " : ""}${fact.qualifiedName}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const signatures = group.filter((fact) => !implementations.has(fact));
    const byArity = new Map<number, SymbolFact[]>();
    for (const fact of signatures) {
      const arity = fact.params?.length ?? 0;
      byArity.set(arity, [...(byArity.get(arity) ?? []), fact]);
    }
    // Signatures of the same arity are numbered in source order: `f(1)#1`, `f(1)#2`.
    for (const [arity, same] of byArity) {
      same.forEach((fact, i) => {
        fact.id = `${fact.id}(${arity})${same.length > 1 ? `#${i + 1}` : ""}`;
      });
    }
  }
  for (const fact of symbols) disambiguateOverloads(fact.members, implementations);
}

function importsOf(grammar: Grammar, root: Node, rangeOf: (node: Node) => Range): ImportFact[] {
  const imports: ImportFact[] = [];
  const query = grammar.query(MODULE_STATEMENTS.source, MODULE_STATEMENTS.captures);
  for (const { name, node } of query.captures(root)) {
    const source = node.childForFieldName("source");
    const requireClause = node.namedChildren.find((c) => c?.type === "import_require_clause");
    if (requireClause) {
      const module = requireClause.childForFieldName("source");
      imports.push({
        module: module ? stringValue(module) : "",
        kind: "require",
        names: [{ name: "*", alias: requireClause.namedChildren[0]!.text }],
        range: rangeOf(node),
      });
      continue;
    }
    if (!source) continue;
    const names: ImportedName[] = [];
    for (const part of node.namedChildren) {
      if (!part) continue;
      if (part.type === "import_clause") {
        for (const clause of part.namedChildren) {
          if (clause?.type === "identifier") names.push({ name: "default", alias: clause.text });
          else if (clause?.type === "namespace_import") {
            names.push({ name: "*", alias: clause.namedChildren[0]!.text });
          } else if (clause?.type === "named_imports") names.push(...specifiers(clause));
        }
      } else if (part.type === "export_clause") names.push(...specifiers(part));
      else if (part.type === "namespace_export") {
        names.push({ name: "*", alias: part.namedChildren[0]!.text });
      }
    }
    if (name === "reexport" && names.length === 0) names.push({ name: "*" });
    const typeOnly = node.children.some((c) => c?.type === "type");
    imports.push({
      module: stringValue(source),
      kind: name === "reexport" ? "reexport" : typeOnly ? "type" : "static",
      names,
      range: rangeOf(node),
    });
  }

  // Literal `import("…")` and `require("…")`.
  const calls = grammar.query(CALLS.source, CALLS.captures);
  for (const { name, node } of calls.captures(root)) {
    if (name !== "call") continue;
    const callee = node.childForFieldName("function");
    const args = node.childForFieldName("arguments")?.namedChildren ?? [];
    const dynamic = callee?.type === "import";
    const required = callee?.type === "identifier" && callee.text === "require";
    if ((!dynamic && !required) || args.length !== 1 || args[0]?.type !== "string") continue;
    imports.push({
      module: stringValue(args[0]),
      kind: dynamic ? "dynamic" : "require",
      names: [],
      range: rangeOf(node),
    });
  }
  return imports.sort((a, b) => compareRanges(a.range, b.range));
}

function specifiers(clause: Node): ImportedName[] {
  return clause.namedChildren.flatMap((specifier) => {
    const name = specifier?.childForFieldName("name")?.text;
    const alias = specifier?.childForFieldName("alias")?.text;
    if (!name) return [];
    return [alias && alias !== name ? { name, alias } : { name }];
  });
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
    if (name !== "callee" || node.type === "import") continue;
    const call = node.parent!;
    const range = rangeOf(call);
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

/** The `export` token at the end of `node`: the token itself, or the last child of an `ERROR`. */
function trailingExport(node: Node | null): Node | undefined {
  if (node?.type === "export") return node;
  const last = node?.type === "ERROR" ? node.lastChild : null;
  return last?.type === "export" ? last : undefined;
}

/** Statements that are complete even when they sit inside an `ERROR` node. */
const isCompleteStatement = (node: Node): boolean =>
  node.isNamed &&
  !node.hasError &&
  (/_(declaration|statement)$/.test(node.type) ||
    ["class", "internal_module", "module", "comment"].includes(node.type));

/**
 * The syntax errors of the file as `[start, end)` offsets: missing nodes, and the parts of each
 * `ERROR` node that aren't complete statements. Tree-sitter often wraps a whole file in one
 * `ERROR` node; reporting only the broken parts points at the actual mistake.
 */
function parseErrorsOf(root: Node): [number, number][] {
  const errors: [number, number][] = [];
  const walk = (node: Node): void => {
    if (node.isMissing) {
      errors.push([node.startIndex, node.endIndex]);
      return;
    }
    if (node.isError) {
      const children = node.children.filter((c): c is Node => c !== null);
      const complete = new Set(children.filter(isCompleteStatement));
      if (complete.size === 0) {
        errors.push([node.startIndex, node.endIndex]);
        return;
      }
      // `export` (and `default`) before a complete declaration belong to it, also when the
      // `export` token ends a nested `ERROR` node.
      const ends = new Map(children.map((c) => [c, c.endIndex]));
      for (let i = children.length - 1; i > 0; i--) {
        if (!complete.has(children[i]!)) continue;
        let j = i - 1;
        if (children[j]!.type === "default") complete.add(children[j--]!);
        const token = j >= 0 ? trailingExport(children[j]!) : undefined;
        if (!token) continue;
        if (token === children[j] || token.startIndex === children[j]!.startIndex) {
          complete.add(children[j]!);
        } else {
          ends.set(children[j]!, token.startIndex);
        }
      }
      let run: [number, number] | undefined;
      for (const child of children) {
        if (complete.has(child)) {
          if (run) errors.push(run);
          run = undefined;
        } else {
          const end = ends.get(child)!;
          run = run ? [run[0], end] : [child.startIndex, end];
        }
      }
      if (run) errors.push(run);
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

const compareRanges = (a: Range, b: Range): number =>
  comparePositions(a.start, b.start) || comparePositions(a.end, b.end);

/** True when `outer` contains `inner`. */
const contains = (outer: Range, inner: Range): boolean =>
  comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
