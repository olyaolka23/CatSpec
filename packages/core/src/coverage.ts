/**
 * `catspec coverage` (analysis F-3, plan §D10), PBI `check-command`: how much of the specs is
 * met, how much of them is machine-checked, and how much of the code is bound by a spec.
 */
import type { Codebase } from "./codebase.js";
import { checkCode, type CheckOptions, type ItemResult } from "./check.js";
import type { SpecModel } from "./load.js";

export interface Ratio {
  count: number;
  total: number;
  /** `count / total` in percent, rounded to one decimal; 100 when `total` is 0. */
  percent: number;
}

export interface SpecCoverage {
  spec: string;
  status: string;
  satisfaction: Ratio;
  enforceable: number;
  manual: number;
  unenforcedProse: number;
}

export interface CoverageReport {
  /** Passing enforceable contract items out of all enforceable items. */
  satisfaction: Ratio;
  /** Enforceable items out of all contract statements: enforceable, manual and unenforced prose (CS0111). */
  enforcement: Ratio & { manual: number; unenforcedProse: number };
  /** Source files with a bound declaration out of all source files. */
  reverse: Ratio;
  specs: SpecCoverage[];
  items: ItemResult[];
}

const ratio = (count: number, total: number): Ratio => ({
  count,
  total,
  percent: total === 0 ? 100 : Math.round((count / total) * 1000) / 10,
});

/**
 * Evaluates every spec except deprecated ones as if implemented, whatever its status, and
 * counts the results.
 */
export async function coverage(
  model: SpecModel,
  codebase: Codebase,
  options: Pick<CheckOptions, "now"> = {},
): Promise<CoverageReport> {
  const result = await checkCode(model, codebase, { ...options, mode: "full" });
  const unenforced = (id: string): number =>
    model.config.enforcement.unenforced_prose === "off"
      ? 0
      : (model.specs.get(id)?.body.contracts.filter((c) => c.references.length === 0).length ?? 0);

  const specs = result.checked.map((spec): SpecCoverage => {
    const items = result.items.filter((i) => i.spec === spec.id);
    const enforceable = items.filter((i) => i.enforceable);
    return {
      spec: spec.id,
      status: spec.status,
      satisfaction: ratio(enforceable.filter((i) => i.passed).length, enforceable.length),
      enforceable: enforceable.length,
      manual: items.length - enforceable.length,
      unenforcedProse: unenforced(spec.id),
    };
  });
  const sum = (key: "enforceable" | "manual" | "unenforcedProse"): number =>
    specs.reduce((n, s) => n + s[key], 0);
  const enforceable = sum("enforceable");
  const manual = sum("manual");
  const unenforcedProse = sum("unenforcedProse");
  const bound = new Set(
    [...result.resolved.values()].flatMap((bindings) =>
      [...bindings.values()].flatMap((r) => r.files),
    ),
  );
  return {
    satisfaction: ratio(result.items.filter((i) => i.enforceable && i.passed).length, enforceable),
    enforcement: {
      ...ratio(enforceable, enforceable + manual + unenforcedProse),
      manual,
      unenforcedProse,
    },
    reverse: ratio(codebase.files.filter((f) => bound.has(f.path)).length, codebase.files.length),
    specs,
    items: result.items,
  };
}
