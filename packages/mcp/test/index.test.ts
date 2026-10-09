import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("@catspec/mcp", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@catspec/mcp");
  });
});
