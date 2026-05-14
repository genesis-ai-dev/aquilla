import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  lookupUser,
  listProjectMembers,
  addProjectMember,
  removeProjectMember,
  type ProjectMember,
} from "./members";

const ORIG = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIG;
});

describe("lookupUser", () => {
  it("returns user on 200", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 7, username: "anna" }), { status: 200 })
    );
    const result = await lookupUser("jwt", "anna");
    expect(result).toEqual({ id: 7, username: "anna" });
  });

  it("returns null on 404", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("", { status: 404 }));
    const result = await lookupUser("jwt", "ghost");
    expect(result).toBeNull();
  });
});

describe("listProjectMembers", () => {
  it("returns members array on 200", async () => {
    const members: ProjectMember[] = [
      { userId: 1, username: "wendy", role: { level: 700, name: "owner", source: "creator" } },
    ];
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ members }), { status: 200 })
    );
    const result = await listProjectMembers("jwt", "p1");
    expect(result).toEqual(members);
  });

  // Treat 403 / 404 as "no server-side membership" — local-only projects on
  // the dashboard hit this all the time and should not be surfaced as errors.
  it("returns null on 403 (caller has no access)", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "no access" }), { status: 403 })
    );
    expect(await listProjectMembers("jwt", "p1")).toBeNull();
  });

  it("returns null on 404 (project does not exist server-side)", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await listProjectMembers("jwt", "p1")).toBeNull();
  });

  it("throws on 5xx (real failure)", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response("server down", { status: 503 })
    );
    await expect(listProjectMembers("jwt", "p1")).rejects.toThrow(/HTTP 503/);
  });
});

describe("addProjectMember", () => {
  it("POSTs username + role", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: 11, username: "clayton", role: { level: 400, name: "contributor", source: "override" } }), { status: 200 })
    );
    const result = await addProjectMember("jwt", "p1", "clayton", 400);
    expect(result.username).toBe("clayton");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/projects/p1/members"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "clayton", role: 400 }),
      })
    );
  });
});

describe("removeProjectMember", () => {
  it("DELETEs by user id", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ removed: true }), { status: 200 })
    );
    await removeProjectMember("jwt", "p1", 11);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/projects/p1/members/11"),
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
