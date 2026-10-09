/**
 * The dependency graph of specs (plan §D8, analysis F-11), PBI `dependency-graph`: `depends_on`
 * edges, unknown dependencies (CS0104), cycles with their full path (CS0105), a topological order
 * and which specs are ready to start.
 */
import { compareStrings, createDiagnostic, type Diagnostic } from "./diagnostics.js";
import { specLocation, type Spec } from "./spec.js";
import { didYouMean } from "./util.js";

export class DependencyGraph {
  /** Specs by id, sorted by id. */
  readonly specs: ReadonlyMap<string, Spec>;
  /** CS0104 and CS0105 diagnostics. */
  readonly diagnostics: Diagnostic[] = [];
  /** Each cycle as a path that ends where it starts: `["a", "b", "c", "a"]`. */
  readonly cycles: string[][] = [];

  private readonly edges = new Map<string, string[]>();
  private readonly reverse = new Map<string, string[]>();

  constructor(specs: Iterable<Spec>) {
    const sorted = [...specs].sort((a, b) => compareStrings(a.id, b.id));
    this.specs = new Map(sorted.map((s) => [s.id, s]));

    for (const spec of sorted) {
      const deps: string[] = [];
      spec.dependsOn.forEach((dep, index) => {
        if (this.specs.has(dep)) {
          if (!deps.includes(dep)) deps.push(dep);
          return;
        }
        const close = didYouMean(dep, this.specs.keys());
        this.diagnostics.push(
          createDiagnostic("CS0104", {
            spec: spec.id,
            specLocation: specLocation(spec.source, ["depends_on", index]),
            message: `"${spec.id}" depends on "${dep}", but there is no spec with that id`,
            actual: dep,
            ...(close.length > 0
              ? { suggestions: close.map((c) => ({ message: `did you mean "${c}"?` })) }
              : {}),
          }),
        );
      });
      deps.sort(compareStrings);
      this.edges.set(spec.id, deps);
      for (const dep of deps) {
        this.reverse.set(dep, [...(this.reverse.get(dep) ?? []), spec.id]);
      }
    }
    for (const list of this.reverse.values()) list.sort(compareStrings);
    this.findCycles();
  }

  /** Known specs `id` depends on, sorted. */
  dependencies(id: string): string[] {
    return this.edges.get(id) ?? [];
  }

  /** Specs that depend on `id`, sorted. */
  dependents(id: string): string[] {
    return this.reverse.get(id) ?? [];
  }

  /** Every edge as `{ spec, dependsOn }`, sorted. */
  edgeList(): { spec: string; dependsOn: string }[] {
    return [...this.edges].flatMap(([spec, deps]) =>
      deps.map((dependsOn) => ({ spec, dependsOn })),
    );
  }

  /**
   * True when every dependency exists and is satisfied. Until contracts are checked, a dependency
   * is satisfied when its status is `implemented`.
   */
  depsSatisfied(id: string): boolean {
    const spec = this.specs.get(id);
    if (!spec) return false;
    return spec.dependsOn.every((dep) => this.specs.get(dep)?.status === "implemented");
  }

  /** A spec is ready to start when its status is `ready` and its dependencies are satisfied. */
  isReady(id: string): boolean {
    return this.specs.get(id)?.status === "ready" && this.depsSatisfied(id);
  }

  /**
   * Specs in dependency order: every spec comes after the specs it depends on. Ties are broken by
   * id; specs in a cycle come after everything else that doesn't depend on them.
   */
  topologicalOrder(): string[] {
    const remaining = new Map([...this.edges].map(([id, deps]) => [id, deps.length]));
    const order: string[] = [];
    while (remaining.size > 0) {
      let next = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
      if (next.length === 0) next = [[...remaining.keys()].sort(compareStrings)[0]!];
      for (const id of next.sort(compareStrings)) {
        remaining.delete(id);
        order.push(id);
        for (const dependent of this.dependents(id)) {
          const count = remaining.get(dependent);
          if (count !== undefined) remaining.set(dependent, Math.max(0, count - 1));
        }
      }
    }
    return order;
  }

  /** Tarjan's strongly connected components; reports one cycle per component. */
  private findCycles(): void {
    let counter = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const components: string[][] = [];

    const connect = (id: string): void => {
      index.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      for (const dep of this.dependencies(id)) {
        if (!index.has(dep)) {
          connect(dep);
          low.set(id, Math.min(low.get(id)!, low.get(dep)!));
        } else if (onStack.has(dep)) {
          low.set(id, Math.min(low.get(id)!, index.get(dep)!));
        }
      }
      if (low.get(id) === index.get(id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== id);
        components.push(component);
      }
    };
    for (const id of this.edges.keys()) if (!index.has(id)) connect(id);

    for (const component of components) {
      const members = new Set(component);
      const start = [...members].sort(compareStrings)[0]!;
      if (members.size === 1 && !this.dependencies(start).includes(start)) continue;
      const cycle = this.shortestCycle(start, members);
      this.cycles.push(cycle);
      const spec = this.specs.get(start)!;
      const next = cycle[1]!;
      this.diagnostics.push(
        createDiagnostic("CS0105", {
          spec: start,
          specLocation: specLocation(spec.source, ["depends_on", spec.dependsOn.indexOf(next)]),
          message: `dependency cycle: ${cycle.join(" → ")}`,
          actual: cycle,
          suggestions: [{ message: "remove one of the dependencies in the cycle" }],
        }),
      );
    }
    this.cycles.sort((a, b) => compareStrings(a[0]!, b[0]!));
  }

  /** Shortest path from `start` back to itself inside one component (breadth-first). */
  private shortestCycle(start: string, members: Set<string>): string[] {
    const previous = new Map<string, string>();
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      for (const dep of this.dependencies(id)) {
        if (!members.has(dep)) continue;
        if (dep === start) {
          const path = [start];
          for (let at = id; at !== start; at = previous.get(at)!) path.splice(1, 0, at);
          return [...path, start];
        }
        if (!previous.has(dep)) {
          previous.set(dep, id);
          queue.push(dep);
        }
      }
    }
    return [start, start];
  }
}
