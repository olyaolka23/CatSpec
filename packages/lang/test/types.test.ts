import { describe, expect, it } from "vitest";

import { nameMatches, normalizeTypeText, parseTypeRef, typeMatches } from "../src/index.js";

const matches = (expected: string, found: string): boolean =>
  typeMatches(parseTypeRef(expected), parseTypeRef(found));

describe("type normaliser", () => {
  it.each([
    [
      "IMessageHandler<UserUpdatedEvent>",
      "Contracts.IMessageHandler<Events.UserUpdatedEvent>",
      true,
    ],
    ["IMessageHandler<UserUpdatedEvent>", "IMessageHandler<UserDeletedEvent>", false],
    ["Handler", "MyHandler", false],
  ])("[AC-type-normaliser-1] %s matched against %s is %s", (expected, found, match) => {
    expect(matches(expected, found)).toBe(match);
  });

  it("parses a qualified generic type into a tree", () => {
    expect(parseTypeRef(" A.B < C.D ,E > ")).toEqual({
      text: "A.B<C.D, E>",
      name: ["A", "B"],
      args: [
        { text: "C.D", name: ["C", "D"], args: [] },
        { text: "E", name: ["E"], args: [] },
      ],
    });
  });

  it("parses nested generics and drops global::", () => {
    const ref = parseTypeRef("global::System.Collections.Generic.Dictionary<string, List<int>>");
    expect(ref.text).toBe("System.Collections.Generic.Dictionary<string, List<int>>");
    expect(ref.args[1]).toEqual({
      text: "List<int>",
      name: ["List"],
      args: [{ text: "int", name: ["int"], args: [] }],
    });
  });

  it("keeps text that isn't a qualified name as normalised text only", () => {
    expect(parseTypeRef("string  |  null")).toEqual({ text: "string|null", name: [], args: [] });
    expect(parseTypeRef("Map<string")).toEqual({ text: "Map<string", name: [], args: [] });
    expect(parseTypeRef("A..B").name).toEqual([]);
    expect(matches("string | null", "string|null")).toBe(true);
    expect(matches("Foo", "string | Foo")).toBe(false);
  });

  it("needs the same number of generic arguments", () => {
    expect(matches("Handler<A>", "Handler<A, B>")).toBe(false);
    expect(matches("Handler", "Handler<A>")).toBe(false);
    expect(matches("Promise<boolean>", "Promise<boolean>")).toBe(true);
  });

  it("matches the found name's suffix only, not the other way round", () => {
    expect(matches("Events.Created", "Created")).toBe(false);
    expect(matches("Events.Created", "App.Events.Created")).toBe(true);
  });

  it("normalises whitespace around punctuation", () => {
    expect(normalizeTypeText("Map< string ,\n  number >")).toBe("Map<string, number>");
    expect(normalizeTypeText("keyof  T")).toBe("keyof T");
    expect(normalizeTypeText("(a: A) => B")).toBe("(a:A)=>B");
  });

  it("matches symbol names by qualified-name suffix", () => {
    expect(nameMatches("AuthService", "Auth.AuthService")).toBe(true);
    expect(nameMatches("AuthService.login", "AuthService.login")).toBe(true);
    expect(nameMatches("Service", "AuthService")).toBe(false);
    expect(nameMatches("Other.AuthService", "Auth.AuthService")).toBe(false);
  });
});
