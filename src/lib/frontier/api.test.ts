import { describe, it, expect, vi } from "vitest";
import { listGroups, listGroupProjects } from "./api";
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

describe("listGroupProjects", () => {
  it("hits gitlab /groups/{id}/projects with PRIVATE-TOKEN", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        id: 42, name: "P", path_with_namespace: "g/p", description: null,
        http_url_to_repo: "https://gitlab.example/g/p.git",
        default_branch: "main", last_activity_at: "2026-04-01",
      }]), { status: 200 })
    );
    const out = await listGroupProjects(session, 7);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("https://gitlab.example/api/v4/groups/7/projects?per_page=100"),
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "g" }),
      })
    );
    expect(out[0].id).toBe(42);
  });
});
