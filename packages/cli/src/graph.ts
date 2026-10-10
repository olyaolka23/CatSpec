/**
 * `catspec graph` (plan §D10): the dependency graph as mermaid, DOT or JSON. Edges point from a
 * dependency to the spec that needs it, i.e. in the order of work.
 */
import type { DependencyGraph, Spec } from "@catspec/core";

export const GRAPH_FORMATS = ["mermaid", "dot", "json"] as const;
export type GraphFormat = (typeof GRAPH_FORMATS)[number];

/** The ids to draw: everything, or `focus` with its transitive dependencies and dependents. */
export function graphNodes(graph: DependencyGraph, focus?: string): string[] {
  if (focus === undefined) return [...graph.specs.keys()];
  // Two separate walks: a spec reached as a dependency still gets its own dependents visited.
  const reach = (next: (id: string) => string[]): Set<string> => {
    const seen = new Set<string>([focus]);
    const stack = [focus];
    while (stack.length > 0) {
      for (const other of next(stack.pop()!)) {
        if (!seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
    }
    return seen;
  };
  const dependencies = reach((id) => graph.dependencies(id));
  const dependents = reach((id) => graph.dependents(id));
  return [...graph.specs.keys()].filter((id) => dependencies.has(id) || dependents.has(id));
}

export function formatGraph(graph: DependencyGraph, format: GraphFormat, focus?: string): string {
  const ids = graphNodes(graph, focus);
  const nodes = ids.map((id) => graph.specs.get(id)!);
  const keep = new Set(ids);
  const edges = graph.edgeList().filter((e) => keep.has(e.spec) && keep.has(e.dependsOn));

  if (format === "json") {
    const json = {
      nodes: nodes.map((s: Spec) => ({ id: s.id, title: s.title, status: s.status, file: s.file })),
      edges,
    };
    return `${JSON.stringify(json, null, 2)}\n`;
  }

  if (format === "dot") {
    const quote = (text: string): string => JSON.stringify(text);
    const lines = ["digraph catspec {", "  rankdir=LR;"];
    for (const s of nodes) lines.push(`  ${quote(s.id)} [label=${quote(`${s.id}\n${s.status}`)}];`);
    for (const e of edges) lines.push(`  ${quote(e.dependsOn)} -> ${quote(e.spec)};`);
    lines.push("}");
    return `${lines.join("\n")}\n`;
  }

  // Mermaid node ids: spec ids with "-" → "_", prefixed so a spec can't be called `end`.
  const node = (id: string): string => `s_${id.replace(/-/g, "_")}`;
  const lines = ["graph LR"];
  for (const s of nodes) lines.push(`  ${node(s.id)}["${s.id} · ${s.status}"]`);
  for (const e of edges) lines.push(`  ${node(e.dependsOn)} --> ${node(e.spec)}`);
  return `${lines.join("\n")}\n`;
}
