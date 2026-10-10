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
  /** Strongly connected components (each sorted by id); a cycle is a component of 2+ specs. */
  private readonly components: string[][] = [];
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
   * Specs in dependency order: every spec comes after the specs it depends on, the members of a
   * cycle together. Among the specs that can come next, the smallest id goes first.
   */
  topologicalOrder(): string[] {
    const componentOf = new Map<string, number>();
    this.components.forEach((members, index) => {
      for (const id of members) componentOf.set(id, index);
    });
    const waitingOn = this.components.map(() => new Set<number>());
    const neededBy = this.components.map(() => new Set<number>());
    for (const { spec, dependsOn } of this.edgeList()) {
      const from = componentOf.get(spec)!;
      const to = componentOf.get(dependsOn)!;
      if (from === to) continue;
      waitingOn[from]!.add(to);
      neededBy[to]!.add(from);
    }
    const order: string[] = [];
    const available = this.components.map((_, i) => i).filter((i) => waitingOn[i]!.size === 0);
    while (available.length > 0) {
      available.sort((a, b) => compareStrings(this.components[a]![0]!, this.components[b]![0]!));
      const next = available.shift()!;
      order.push(...this.components[next]!);
      for (const dependent of neededBy[next]!) {
        waitingOn[dependent]!.delete(next);
        if (waitingOn[dependent]!.size === 0) available.push(dependent);
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
    const components = this.components;

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
        components.push(component.sort(compareStrings));
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
