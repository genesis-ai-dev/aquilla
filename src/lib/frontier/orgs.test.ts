import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getOrCreateMyOrg,
  listOrgMembers,
  addOrgMember,
  removeOrgMember,
  listOrgMemberProjects,
  listMyOrgs,
} from "./orgs";

const ORIG = global.fetch;
beforeEach(() => { global.fetch = vi.fn(); });
afterEach(() => { global.fetch = ORIG; });

describe("getOrCreateMyOrg", () => {
  it("returns org from /orgs/me", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 5, name: "anna", role: { level: 700, name: "owner" } }), { status: 200 })
    );
    const org = await getOrCreateMyOrg("jwt");
    expect(org.id).toBe(5);
    expect(org.role.level).toBe(700);
  });
});

describe("listOrgMembers", () => {
  it("returns members from GET", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ members: [{ userId: 1, username: "wendy", role: { level: 700, name: "owner" } }] }), { status: 200 })
    );
    const members = await listOrgMembers("jwt", 5);
    expect(members).toHaveLength(1);
  });
});

describe("addOrgMember", () => {
  it("POSTs username + role", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: 7, username: "anna", role: { level: 600, name: "maintainer" } }), { status: 200 })
    );
    const result = await addOrgMember("jwt", 5, "anna", 600);
    expect(result.username).toBe("anna");
  });
});

describe("removeOrgMember", () => {
  it("DELETEs by user id", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ removed: true }), { status: 200 })
    );
    await removeOrgMember("jwt", 5, 11);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/orgs/5/members/11"),
      expect.objectContaining({ method: "DELETE" })
    );
  });
});

describe("listOrgMemberProjects", () => {
  it("returns project list", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ projects: [{ id: "p1", name: "P1", role: { level: 400, name: "contributor" } }] }), { status: 200 })
    );
    const projects = await listOrgMemberProjects("jwt", 5, 11);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("p1");
  });
});

describe("listMyOrgs", () => {
  it("GETs /api/v2/orgs and returns the orgs array", async () => {
    let calledUrl = ""
    global.fetch = vi.fn(async (input) => {
      calledUrl = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ orgs: [{ id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const orgs = await listMyOrgs("jwt-123")
    expect(calledUrl).toMatch(/\/api\/v2\/orgs$/)
    expect(orgs).toEqual([{ id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } }])
  })
  it("throws on non-OK", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    await expect(listMyOrgs("jwt")).rejects.toThrow(/HTTP 500/)
  })
});
