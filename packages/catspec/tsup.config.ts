import { defineConfig } from "tsup";

import { packageBuild } from "../../tsup.shared.js";

export default defineConfig({ ...packageBuild, entry: ["src/index.ts", "src/bin.ts"] });
