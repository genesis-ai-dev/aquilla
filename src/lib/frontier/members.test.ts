import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  lookupUser,
  listProjectMembers,
  fetchOrgMembersMatrix,
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
      { userId: 1, username: "wendy", role: { level: 700, name: "owner", source: "creator" }, secondarySources: [] },
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

  it("throws on 5xx (real failure) with a human message, not 'HTTP 503'", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response("server down", { status: 503 })
    );
    const err = await listProjectMembers("jwt", "p1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/HTTP\s*503/);
    expect((err as Error).name).toBe("UserError");
  });
});

describe("fetchOrgMembersMatrix (AQU-218)", () => {
  // The whole point of this endpoint is ONE request for the matrix instead of
  // one-per-project. Guard that the client issues a single org-scoped call and
  // keys the result by projectId for cell lookup.
  it("issues one org-scoped request and maps projectId → members", async () => {
    const alice: ProjectMember = { userId: 1, username: "alice", role: { level: 700, name: "owner", source: "creator" }, secondarySources: [] };
    const bob: ProjectMember = { userId: 2, username: "bob", role: { level: 400, name: "contributor", source: "org" }, secondarySources: [] };
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ projects: [
        { projectId: "p1", members: [alice, bob] },
        { projectId: "p2", members: [alice] },
      ] }), { status: 200 })
    );

    const map = await fetchOrgMembersMatrix("jwt", 21);

    expect((global.fetch as any).mock.calls).toHaveLength(1);
    expect((global.fetch as any).mock.calls[0][0]).toContain("/orgs/21/members-matrix");
    expect(map.get("p1")).toEqual([alice, bob]);
    expect(map.get("p2")).toEqual([alice]);
    expect(map.get("p3")).toBeUndefined();
  });

  // An org with no accessible projects must yield an empty matrix, not an error
  // (AC: genuinely-empty still renders, no false 500).
  it("returns an empty map when the org has no projects", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ projects: [] }), { status: 200 })
    );
    const map = await fetchOrgMembersMatrix("jwt", 21);
    expect(map.size).toBe(0);
  });

  it("throws on non-ok (the failure that used to surface as a page 500) — human message", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const err = await fetchOrgMembersMatrix("jwt", 21).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/HTTP\s*500/);
    expect((err as Error).name).toBe("UserError");
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
