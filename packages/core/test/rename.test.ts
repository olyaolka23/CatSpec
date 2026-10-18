/**
 * The rename score of plan §D11.4 and the name-free fingerprint of §D11.8 (PBIs
 * `rename-detection`, `batch-rename-mapping`), on hand-written shapes and tokens.
 */
import { describe, expect, it } from "vitest";

import {
  bodyTokens,
  jaccard,
  memberNames,
  nameFreeFingerprint,
  renameScore,
  tokenSimilarity,
  type Shape,
  type SymbolFact,
} from "../src/index.js";

const shape = (name: string, members: string[], extra: Partial<Shape> = {}): Shape => ({
  kind: "class",
  name,
  bases: [],
  attributes: [],
  modifiers: [],
  members,
  ...extra,
});

describe("rename score", () => {
  it("weights member names 0.5, body tokens 0.4 and the same file 0.1", () => {
    const before = {
      shape: shape("A", ["method run():void", "method stop():void"]),
      tokens: ["a", "b", "c", "d"],
    };
    expect(renameScore(before, { ...before, shape: shape("B", before.shape.members) }, true)).toBe(
      1,
    );
    expect(renameScore(before, { ...before, shape: shape("B", before.shape.members) }, false)).toBe(
      0.9,
    );
    const half = { shape: shape("B", ["method run():void", "method go():void"]), tokens: [] };
    // Members {run, stop} vs {run, go}: 1/3; no tokens; another file.
    expect(renameScore(before, half, false)).toBeCloseTo(0.5 / 3, 5);
  });

  it("compares the signatures of declarations without members", () => {
    const fn = (signature: string): Shape => shape("f", [], { kind: "function", signature });
    const tokens = ["x"];
    expect(
      renameScore(
        { shape: fn("(string):void"), tokens },
        { shape: fn("(string):void"), tokens },
        false,
      ),
    ).toBe(0.9);
    expect(
      renameScore({ shape: fn("(string):void"), tokens }, { shape: fn("():void"), tokens }, false),
    ).toBe(0.4);
  });

  it("token similarity is Jaccard over 3-grams, 0 for an unknown body", () => {
    expect(tokenSimilarity(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toBe(1);
    expect(tokenSimilarity(["a", "b", "c", "d"], ["a", "b", "c", "e"])).toBeCloseTo(1 / 3, 5);
    expect(tokenSimilarity([], ["a"])).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("reads member names from shape member signatures", () => {
    expect(
      memberNames(
        shape("A", [
          "public static method create(string,number):A",
          "readonly property id:string",
          "method run",
        ]),
      ),
    ).toEqual(["create", "id", "run"]);
  });

  it("blanks a C# constructor's name, so a renamed class keeps its member names", () => {
    const members = (name: string, extra: string[] = []): string[] => [
      `public constructor ${name}(ILogger)`,
      ...["A", "B", "C", "D", ...extra].map((m) => `public method ${m}():void`),
    ];
    const tokens = ["a", "b", "c", "d"];
    const before = shape("Identity.User", members("User"));
    const after = shape("Identity.Account", members("Account", ["E"]));
    expect(memberNames(before)[0]).toBe("∅");
    expect(renameScore({ shape: before, tokens }, { shape: after, tokens }, true)).toBeGreaterThan(
      0.8,
    );
  });
});

describe("name-free fingerprint", () => {
  it("is the same when only the name and namespace change, C# constructors included", () => {
    const before = shape("Identity.UserHandler", [
      "public constructor UserHandler(ILogger)",
      "public method Handle():void",
    ]);
    const after = shape("Accounts.AccountHandler", [
      "public constructor AccountHandler(ILogger)",
      "public method Handle():void",
    ]);
    expect(nameFreeFingerprint(before)).toBe(nameFreeFingerprint(after));
    expect(nameFreeFingerprint(before)).not.toBe(
      nameFreeFingerprint(shape("Accounts.AccountHandler", ["public method Handle(string):void"])),
    );
  });
});

describe("body tokens", () => {
  it("tokenises a declaration's source without its own name", () => {
    const text = "export class UserHandler {\n  run() { return UserHandler.x + 1; }\n}\n";
    const symbol = {
      name: "UserHandler",
      range: { start: { line: 1, column: 8 }, end: { line: 3, column: 2 } },
    } as SymbolFact;
    expect(bodyTokens({ path: "a.ts", text, blobSha: "" }, symbol)).toEqual([
      "class",
      "{",
      "run",
      "(",
      ")",
      "{",
      "return",
      ".",
      "x",
      "+",
      "1",
      ";",
      "}",
      "}",
    ]);
  });
});
