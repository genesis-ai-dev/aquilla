import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getMyOrg,
  createPersonalOrg,
  listOrgMembers,
  addOrgMember,
  removeOrgMember,
  listOrgMemberProjects,
  listMyOrgs,
  listOrgsPage,
} from "./orgs";

const ORIG = global.fetch;
beforeEach(() => { global.fetch = vi.fn(); });
afterEach(() => { global.fetch = ORIG; });

describe("getMyOrg", () => {
  it("returns org from /orgs/me", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 5, name: "anna", role: { level: 700, name: "owner" } }), { status: 200 })
    );
    const org = await getMyOrg("jwt");
    expect(org?.id).toBe(5);
    expect(org?.role.level).toBe(700);
  });

  // AQU-2259: the read no longer creates a workspace; "none" is an answer.
  it("answers null when the caller owns no organization", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "no_organization" }), { status: 404 })
    );
    expect(await getMyOrg("jwt")).toBeNull();
  });
});

describe("createPersonalOrg", () => {
  it("POSTs to /orgs/personal", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 9, name: "ana's workspace", role: { level: 700, name: "owner" } }), { status: 200 })
    );
    const org = await createPersonalOrg("jwt");
    expect(org.id).toBe(9);
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/\/api\/v2\/orgs\/personal$/);
    expect(init.method).toBe("POST");
  });
});

describe("listOrgMembers", () => {
  it("returns members from GET", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ members: [{ userId: 1, username: "wendy", email: "wendy@example.com", role: { level: 700, name: "owner" } }] }), { status: 200 })
    );
    const members = await listOrgMembers("jwt", 5);
    expect(members).toHaveLength(1);
    expect(members[0].email).toBe("wendy@example.com");
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
  it("throws on non-OK with a human message, not 'HTTP 500'", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    const err = await listMyOrgs("jwt").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/HTTP\s*500/)
    expect((err as Error).name).toBe("UserError")
  })
});

describe("listOrgsPage", () => {
  it("GETs /api/v2/orgs with limit, q, and cursor", async () => {
    let calledUrl = ""
    global.fetch = vi.fn(async (input, init) => {
      calledUrl = typeof input === "string" ? input : (input as Request).url
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-123" })
      return new Response(
        JSON.stringify({
          orgs: [{ id: 9, name: "Foreign", role: { level: 700, name: "admin" }, viaPlatformAdmin: true }],
          nextCursor: "9:Foreign",
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const page = await listOrgsPage("jwt-123", { q: "for", limit: 40, cursor: "1:Acme" })
    expect(calledUrl).toContain("/api/v2/orgs?")
    expect(calledUrl).toContain("q=for")
    expect(calledUrl).toContain("limit=40")
    expect(calledUrl).toContain("cursor=1%3AAcme")
    expect(page).toEqual({
      orgs: [{ id: 9, name: "Foreign", role: { level: 700, name: "admin" }, viaPlatformAdmin: true }],
      nextCursor: "9:Foreign",
    })
  })
});
