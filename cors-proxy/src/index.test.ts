import { describe, it, expect, vi } from "vitest";
import worker from "./index";

describe("cors proxy", () => {
  it("rejects non-frontier host", async () => {
    const req = new Request("https://proxy/https://evil.com/info/refs");
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(403);
  });

  it("handles OPTIONS preflight", async () => {
    const req = new Request(
      "https://proxy/https://gitlab.frontierrnd.com/x.git/info/refs",
      {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Headers": "authorization,content-type" },
      },
    );
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("forwards GET to allowed host", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("packs", {
        status: 200,
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      }),
    );
    const req = new Request(
      "https://proxy/https://gitlab.frontierrnd.com/group/repo.git/info/refs?service=git-upload-pack",
      { headers: { Authorization: "Bearer x" } },
    );
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gitlab.frontierrnd.com/group/repo.git/info/refs?service=git-upload-pack",
      expect.objectContaining({ method: "GET" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
