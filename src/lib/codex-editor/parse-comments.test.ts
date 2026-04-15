import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexComments, mapCodexCommentsToThreads } from "./parse-comments";

const FIXTURE_DIR = join(__dirname, "../../../tests/fixtures/codex-editor");

describe("parseCodexComments", () => {
  it("parses threads by id", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "comments.json"), "utf8");
    const threads = parseCodexComments(raw);
    expect(threads.t1.cellId.cellId).toBe("GEN 1:1");
    expect(threads.t1.comments).toHaveLength(1);
  });
});

describe("mapCodexCommentsToThreads", () => {
  it("groups threads by cellId", () => {
    const threads = {
      t1: {
        id: "t1",
        cellId: { cellId: "GEN 1:1" },
        comments: [
          { id: "c1", timestamp: 1700001000000, body: "hi", mode: 0, deleted: false, author: { name: "alice" } },
        ],
        collapsibleState: 0,
        canReply: true,
      },
    };
    const grouped = mapCodexCommentsToThreads(threads);
    expect(grouped["GEN 1:1"]).toHaveLength(1);
    expect(grouped["GEN 1:1"][0].messages[0].author).toBe("alice");
    expect(grouped["GEN 1:1"][0].status).toBe("open");
  });

  it("marks resolved threads", () => {
    const threads = {
      t2: {
        id: "t2",
        cellId: { cellId: "X" },
        comments: [{ id: "c", timestamp: 1, body: "b", mode: 0, deleted: false, author: { name: "a" } }],
        collapsibleState: 0,
        canReply: true,
        resolvedEvent: [{ timestamp: 99, author: { name: "a" }, resolved: true }],
      },
    };
    const grouped = mapCodexCommentsToThreads(threads);
    expect(grouped["X"][0].status).toBe("resolved");
  });

  it("skips deleted threads", () => {
    const threads = {
      t3: {
        id: "t3",
        cellId: { cellId: "Y" },
        comments: [],
        collapsibleState: 0,
        canReply: true,
        deletionEvent: [{ timestamp: 1, author: { name: "a" }, deleted: true }],
      },
    };
    const grouped = mapCodexCommentsToThreads(threads);
    expect(grouped["Y"]).toBeUndefined();
  });
});
