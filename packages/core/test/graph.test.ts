import { describe, expect, it } from "vitest";

import { specText } from "../../../test/temp-repo.js";
import { DependencyGraph, readSpec, type Spec } from "../src/index.js";

/** Specs from `id: [status, dependencies]`. */
function specs(defs: Record<string, [string, string[]]>): Spec[] {
  return Object.entries(defs).map(([id, [status, dependsOn]]) => {
    const { spec } = readSpec(
      specText(id, { status, ...(dependsOn.length > 0 ? { dependsOn } : {}) }),
      `docs/spec/f/${id}.spec.md`,
    );
    return spec!;
  });
}

describe("dependency-graph", () => {
  it('[AC-dependency-graph-1] reports CS0104 naming the unknown dependency "payments" and the spec that needs it', () => {
    const graph = new DependencyGraph(
      specs({ checkout: ["ready", ["cart", "payments"]], cart: ["ready", []] }),
    );
    expect(graph.diagnostics).toHaveLength(1);
    expect(graph.diagnostics[0]).toMatchObject({
      code: "CS0104",
      spec: "checkout",
      actual: "payments",
      specLocation: { file: "docs/spec/f/checkout.spec.md", line: 6 },
    });
    expect(graph.diagnostics[0]!.message).toContain('"checkout" depends on "payments"');
    expect(graph.dependencies("checkout")).toEqual(["cart"]);
  });

  it("[AC-dependency-graph-2] lists a spec as ready only when its dependencies are implemented", () => {
    const done = new DependencyGraph(specs({ aa: ["implemented", []], bb: ["ready", ["aa"]] }));
    expect(done.isReady("bb")).toBe(true);
    const busy = new DependencyGraph(specs({ aa: ["in-progress", []], bb: ["ready", ["aa"]] }));
    expect(busy.isReady("bb")).toBe(false);
    expect(busy.depsSatisfied("bb")).toBe(false);
    // Only `ready` specs are ready to start, and a spec without dependencies is ready as soon as it is `ready`.
    const statuses = new DependencyGraph(
      specs({ aa: ["ready", []], bb: ["draft", []], cc: ["in-progress", []] }),
    );
    expect(["aa", "bb", "cc"].filter((id) => statuses.isReady(id))).toEqual(["aa"]);
  });

  it("reports a cycle with its full path, once, at the spec where it starts", () => {
    const graph = new DependencyGraph(
      specs({
        aa: ["ready", ["bb"]],
        bb: ["ready", ["cc"]],
        cc: ["ready", ["aa"]],
        dd: ["ready", ["aa"]],
      }),
    );
    expect(graph.cycles).toEqual([["aa", "bb", "cc", "aa"]]);
    expect(graph.diagnostics).toHaveLength(1);
    expect(graph.diagnostics[0]).toMatchObject({
      code: "CS0105",
      spec: "aa",
      specLocation: { line: 6 },
    });
    expect(graph.diagnostics[0]!.message).toBe("dependency cycle: aa → bb → cc → aa");
  });

  it("reports self-dependencies and separate cycles separately", () => {
    const graph = new DependencyGraph(
      specs({ aa: ["ready", ["aa"]], xx: ["ready", ["yy"]], yy: ["ready", ["xx"]] }),
    );
    expect(graph.cycles).toEqual([
      ["aa", "aa"],
      ["xx", "yy", "xx"],
    ]);
  });

  it("orders specs after their dependencies, ties by id", () => {
    const graph = new DependencyGraph(
      specs({
        "token-refresh": ["ready", ["login-api"]],
        "login-api": ["ready", ["register-api"]],
        "email-verification": ["ready", ["register-api"]],
        "register-api": ["ready", []],
      }),
    );
    expect(graph.topologicalOrder()).toEqual([
      "register-api",
      "email-verification",
      "login-api",
      "token-refresh",
    ]);
    expect(graph.dependents("register-api")).toEqual(["email-verification", "login-api"]);
    expect(graph.edgeList()).toHaveLength(3);
  });

  it("orders a spec that depends on a cycle after the whole cycle", () => {
    const graph = new DependencyGraph(
      specs({ aa: ["ready", ["xx"]], xx: ["ready", ["yy"]], yy: ["ready", ["xx"]] }),
    );
    expect(graph.topologicalOrder()).toEqual(["xx", "yy", "aa"]);
  });
});
