import { describe, it, expect, vi } from "vitest";
import { listGroups, listGroupProjectsPage } from "./api";
import type { FrontierSession } from "./types";

const session: FrontierSession = {
  jwt: "j", gitlabToken: "g", gitlabUrl: "https://gitlab.example",
  username: "a", createdAt: "",
};

describe("listGroups", () => {
  it("calls portal/groups with bearer jwt", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: 1, name: "G", path: "g" }]), { status: 200 })
    );
    const out = await listGroups(session);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/portal/groups"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer j" }),
      })
    );
    expect(out[0].name).toBe("G");
  });
});

describe("listGroupProjectsPage", () => {
  it("hits gitlab /groups/{id}/projects with PRIVATE-TOKEN and parses pagination headers", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        id: 42, name: "P", path_with_namespace: "g/p", description: null,
        http_url_to_repo: "https://gitlab.example/g/p.git",
        default_branch: "main", last_activity_at: "2026-04-01",
      }]), {
        status: 200,
        headers: { "x-total": "57", "x-total-pages": "3", "x-next-page": "2" },
      })
    );
    const out = await listGroupProjectsPage(session, 7, 1, 20);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("https://gitlab.example/api/v4/groups/7/projects?per_page=20&page=1"),
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "g" }),
      })
    );
    expect(out.items[0].id).toBe(42);
    expect(out.total).toBe(57);
    expect(out.totalPages).toBe(3);
    expect(out.nextPage).toBe(2);
  });
});
