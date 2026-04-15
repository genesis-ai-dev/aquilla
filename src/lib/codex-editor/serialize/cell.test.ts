import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { serializeCell } from "./cell";
import type { CodexCell } from "@/lib/codex-editor/types";
import { setFragmentFromHtml } from "@/lib/richtext/translated-xml";

function buildYCell(source: CodexCell, lastSyncedHistoryAt = 0): Y.Map<unknown> {
  const doc = new Y.Doc();
  const m = doc.getMap("c");
  const cell = new Y.Map<unknown>();
  cell.set("id", source.metadata.id);
  cell.set("__source", JSON.parse(JSON.stringify(source)));
  cell.set("__lastSyncedHistoryAt", lastSyncedHistoryAt);
  const frag = new Y.XmlFragment();
  cell.set("translatedXml", frag);
  setFragmentFromHtml(frag, source.value);
  cell.set("history", new Y.Array());
  cell.set("threads", new Y.Array());
  m.set("c", cell);
  return cell;
}

describe("serializeCell", () => {
  it("byte-identical output when nothing changed", () => {
    const source: CodexCell = {
      kind: 2,
      languageId: "scripture",
      value: "<p>Im Anfang</p>",
      metadata: {
        id: "GEN 1:1",
        type: "text",
        edits: [
          {
            author: "a",
            timestamp: 1,
            type: "user-edit",
            editMap: ["value"],
            value: "<p>Im Anfang</p>",
          },
        ],
        data: { book: "GEN", chapter: "1", verse: "1" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attachments: { aud1: { type: "audio", url: "x" } as any },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
    const cell = buildYCell(source, 999);
    const out = serializeCell(cell);
    expect(out).toEqual(source);
  });

  it("appends a new edit when text changed", () => {
    const source: CodexCell = {
      kind: 2,
      languageId: "scripture",
      value: "<p>old</p>",
      metadata: { id: "GEN 1:1", type: "text", edits: [] },
    };
    const cell = buildYCell(source, 0);
    const frag = cell.get("translatedXml") as Y.XmlFragment;
    setFragmentFromHtml(frag, "<p>new</p>");
    // Simulate a recorded local edit session via the history Y.Array
    const hist = cell.get("history") as Y.Array<unknown>;
    hist.push([
      {
        timestamp: new Date(50_000).toISOString(),
        value: "<p>new</p>",
        source: "human",
        author: "alice",
        validated: false,
      },
    ]);

    const out = serializeCell(cell);
    expect(out.value).toBe("<p>new</p>");
    expect(out.metadata.edits).toHaveLength(1);
    expect(out.metadata.edits![0]).toMatchObject({
      author: "alice",
      value: "<p>new</p>",
      editMap: ["value"],
      type: "user-edit",
    });
  });

  it("preserves unknown fields (attachments, cellLabel, isLocked)", () => {
    const source: CodexCell = {
      kind: 2,
      languageId: "scripture",
      value: "<p>x</p>",
      metadata: {
        id: "X",
        type: "text",
        cellLabel: "1:1",
        isLocked: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attachments: { a1: { foo: "bar" } as any },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
    const cell = buildYCell(source, 999);
    const out = serializeCell(cell);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out.metadata as any).cellLabel).toBe("1:1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out.metadata as any).isLocked).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out.metadata as any).attachments.a1.foo).toBe("bar");
  });
});
