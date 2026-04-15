import { describe, it, expect } from "vitest";
import { pairCells } from "./pair-cells";
import type { CodexCell } from "./types";

function cell(id: string, value: string, extra: Partial<CodexCell["metadata"]> = {}): CodexCell {
  return {
    kind: 2,
    languageId: "scripture",
    value,
    metadata: { id, type: "text", ...extra },
  };
}

describe("pairCells", () => {
  it("zips source and target cells by id", () => {
    const source = [cell("a", "Hello"), cell("b", "World")];
    const target = [cell("a", "Hallo"), cell("b", "Welt")];
    const paired = pairCells(source, target, "sample");
    expect(paired).toHaveLength(2);
    expect(paired[0].id).toBe("a");
    expect(paired[0].original).toBe("Hello");
    expect(paired[0].translated).toBe("Hallo");
    expect(paired[0].group).toBe("sample");
  });

  it("strips HTML in original, preserves html field", () => {
    const source = [cell("a", "<p>Hello <b>world</b></p>")];
    const target = [cell("a", "Hallo")];
    const paired = pairCells(source, target, "x");
    expect(paired[0].original).toBe("Hello world");
    expect(paired[0].originalHtml).toBe("<p>Hello <b>world</b></p>");
  });

  it("derives context from timestamp data", () => {
    const source = [cell("c1", "...", { data: { startTime: 1.5, endTime: 3.25 } })];
    const target = [cell("c1", "...")];
    const paired = pairCells(source, target, "x");
    expect(paired[0].context).toBe("00:00:01.500 --> 00:00:03.250");
  });

  it("derives context from book/chapter/verse", () => {
    const source = [cell("c", "...", { data: { book: "GEN", chapter: "1", verse: "1" } })];
    const target = [cell("c", "...")];
    const paired = pairCells(source, target, "x");
    expect(paired[0].context).toBe("GEN 1:1");
  });

  it("includes orphan target cells with empty original", () => {
    const source: CodexCell[] = [];
    const target = [cell("only-target", "Welt")];
    const paired = pairCells(source, target, "x");
    expect(paired).toHaveLength(1);
    expect(paired[0].original).toBe("");
    expect(paired[0].translated).toBe("Welt");
  });

  it("includes orphan source cells with empty translated", () => {
    const source = [cell("only-source", "Hello")];
    const target: CodexCell[] = [];
    const paired = pairCells(source, target, "x");
    expect(paired).toHaveLength(1);
    expect(paired[0].original).toBe("Hello");
    expect(paired[0].translated).toBe("");
  });
});
