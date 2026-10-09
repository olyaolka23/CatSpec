import type { Options } from "tsup";

/** Shared tsup options: every package builds `src/index.ts` to ESM with type declarations. */
export const packageBuild: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
};
