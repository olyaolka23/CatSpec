import { describe, expect, it } from "vitest";

import { importTargets, qualifiedNameMatches, typePatternMatches, wildcard } from "../src/index.js";

const type = (text: string, name: string[]) => ({ text, name, args: [] });

describe("rule pattern matching", () => {
  it("matches wildcards across dots, and exact text without one", () => {
    expect(wildcard("console.*")("console.log")).toBe(true);
    expect(wildcard("console.*")("myconsole.log")).toBe(false);
    expect(wildcard("eval")("eval")).toBe(true);
    expect(wildcard("eval")("evaluate")).toBe(false);
  });

  it("matches qualified names by segment suffix, with or without wildcards", () => {
    expect(qualifiedNameMatches("AuthService", "Auth.AuthService")).toBe(true);
    expect(qualifiedNameMatches("Service", "AuthService")).toBe(false);
    expect(qualifiedNameMatches("Legacy*", "Old.LegacyApi")).toBe(true);
    expect(qualifiedNameMatches("Legacy*", "NotLegacy")).toBe(false);
  });

  it("matches type patterns without the namespace of the found type", () => {
    const found = type("Bus.IMessageHandler<Order>", ["Bus", "IMessageHandler"]);
    expect(typePatternMatches("IMessageHandler<*>", found)).toBe(true);
    expect(typePatternMatches("Bus.IMessageHandler<*>", found)).toBe(true);
    expect(typePatternMatches("IHandler<*>", found)).toBe(false);
  });

  it("resolves relative imports to repository paths and package imports to package names", () => {
    expect(importTargets("src/Domain/User.ts", "../Infrastructure/db.js")).toContain(
      "src/Infrastructure/db.ts",
    );
    expect(importTargets("a.ts", "node:fs/promises")).toEqual([
      "node:fs/promises",
      "fs/promises",
      "fs",
    ]);
    expect(importTargets("a.ts", "@catspec/lang/x")).toContain("@catspec/lang");
  });
});
