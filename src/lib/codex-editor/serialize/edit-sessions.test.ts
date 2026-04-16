import { describe, it, expect } from "vitest";
import { collapseToEditSessions, sessionToEditEntry } from "./edit-sessions";
import type { CellHistoryEntry } from "@/lib/parsers/types";

const e = (overrides: Partial<CellHistoryEntry>): CellHistoryEntry => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  value: "v",
  source: "human",
  author: "alice",
  validated: false,
  ...overrides,
});

describe("collapseToEditSessions", () => {
  it("groups contiguous same-author entries within session window", () => {
    const entries = [
      e({ timestamp: "2026-01-01T00:00:00Z", value: "a" }),
      e({ timestamp: "2026-01-01T00:00:30Z", value: "ab" }),
      e({ timestamp: "2026-01-01T00:01:00Z", value: "abc" }),
    ];
    const sessions = collapseToEditSessions(entries);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].finalValue).toBe("abc");
  });

  it("starts a new session when author changes", () => {
    const entries = [
      e({ author: "alice", value: "a" }),
      e({ author: "bob", value: "b", timestamp: "2026-01-01T00:00:01Z" }),
    ];
    expect(collapseToEditSessions(entries)).toHaveLength(2);
  });

  it("starts a new session when gap exceeds window", () => {
    const entries = [
      e({ value: "a", timestamp: "2026-01-01T00:00:00Z" }),
      e({ value: "b", timestamp: "2026-01-01T00:10:00Z" }), // 10 min gap
    ];
    expect(collapseToEditSessions(entries)).toHaveLength(2);
  });
});

describe("sessionToEditEntry", () => {
  it("emits a value-edit", () => {
    const session = {
      author: "alice",
      source: "human" as const,
      validated: true,
      startTimestamp: 1,
      endTimestamp: 2,
      finalValue: "<p>x</p>",
      entries: [],
    };
    const edit = sessionToEditEntry(session);
    expect(edit.editMap).toEqual(["value"]);
    expect(edit.value).toBe("<p>x</p>");
    expect(edit.author).toBe("alice");
    expect(edit.type).toBe("user-edit");
  });
  it("maps llm source to llm-edit", () => {
    const session = {
      author: "bot",
      source: "llm" as const,
      validated: false,
      startTimestamp: 1,
      endTimestamp: 1,
      finalValue: "x",
      entries: [],
    };
    expect(sessionToEditEntry(session).type).toBe("llm-edit");
  });

  it("emits validatedBy when session is validated", () => {
    const session = {
      author: "alice",
      source: "human" as const,
      validated: true,
      startTimestamp: 100,
      endTimestamp: 200,
      finalValue: "v",
      entries: [],
    };
    const edit = sessionToEditEntry(session);
    expect(edit.validatedBy).toEqual([
      { username: "alice", creationTimestamp: 200, updatedTimestamp: 200, isDeleted: false },
    ]);
  });

  it("omits validatedBy when session is not validated", () => {
    const session = {
      author: "alice",
      source: "human" as const,
      validated: false,
      startTimestamp: 100,
      endTimestamp: 200,
      finalValue: "v",
      entries: [],
    };
    expect(sessionToEditEntry(session).validatedBy).toBeUndefined();
  });
});
