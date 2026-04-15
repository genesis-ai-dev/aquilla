import { describe, it, expect } from "vitest";
import { mapEditHistory } from "./map-history";
import type { EditHistory } from "./types";

describe("mapEditHistory", () => {
  it("maps value-only edits to our CellHistoryEntry", () => {
    const edits: EditHistory[] = [
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "v1" },
      { author: "bot", timestamp: 2000, type: "llm-generation", editMap: ["value"], value: "v2" },
    ];
    const out = mapEditHistory(edits);
    expect(out).toHaveLength(2);
    expect(out[0].author).toBe("alice");
    expect(out[0].value).toBe("v1");
    expect(out[0].source).toBe("human");
    expect(out[1].source).toBe("llm");
  });

  it("ignores non-value edits", () => {
    const edits: EditHistory[] = [
      { author: "a", timestamp: 1, type: "user-edit", editMap: ["metadata", "data", "startTime"], value: 5 },
    ];
    expect(mapEditHistory(edits)).toHaveLength(0);
  });

  it("marks validated when any non-deleted validator exists", () => {
    const edits: EditHistory[] = [
      { author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "v",
        validatedBy: [{ username: "b", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }] },
      { author: "a", timestamp: 2, type: "user-edit", editMap: ["value"], value: "v",
        validatedBy: [{ username: "b", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: true }] },
    ];
    const out = mapEditHistory(edits);
    expect(out[0].validated).toBe(true);
    expect(out[1].validated).toBe(false);
  });

  it("fills empty author with 'git-import'", () => {
    const edits: EditHistory[] = [
      { author: "", timestamp: 1, type: "user-edit", editMap: ["value"], value: "v" },
    ];
    expect(mapEditHistory(edits)[0].author).toBe("git-import");
  });

  it("sorts ascending by timestamp", () => {
    const edits: EditHistory[] = [
      { author: "a", timestamp: 3000, type: "user-edit", editMap: ["value"], value: "c" },
      { author: "a", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "a" },
      { author: "a", timestamp: 2000, type: "user-edit", editMap: ["value"], value: "b" },
    ];
    const out = mapEditHistory(edits);
    expect(out.map(e => e.value)).toEqual(["a", "b", "c"]);
  });
});
