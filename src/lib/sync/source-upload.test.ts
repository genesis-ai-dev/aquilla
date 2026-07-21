import { describe, it, expect, vi } from "vitest"
import { bindSourceArtifact, uploadSourceOriginal } from "./source-upload"

describe("uploadSourceOriginal", () => {
  it("PUTs bytes to the source endpoint with format + auth headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await uploadSourceOriginal({
      projectId: "p1", fileId: "f1",
      artifactId: "01900000-0000-7000-8000-000000000001",
      bytes: new Uint8Array([1, 2, 3]).buffer, format: "docx",
      getToken: async () => "tok", fetchFn,
      baseUrl: "https://sync.test",
    })
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://sync.test/api/v1/projects/p1/files/f1/source")
    expect(init.method).toBe("PUT")
    expect(init.headers["X-Source-Format"]).toBe("docx")
    expect(init.headers["X-Source-Size"]).toBe("3")
    expect(init.headers["X-Source-Sha256"]).toMatch(/^[0-9a-f]{64}$/)
    expect(init.headers["X-Artifact-Id"]).toBe("01900000-0000-7000-8000-000000000001")
    expect(init.headers.Authorization).toBe("Bearer tok")
  })

  it("throws on non-2xx", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }))
    await expect(uploadSourceOriginal({
      projectId: "p1", fileId: "f1", artifactId: "01900000-0000-7000-8000-000000000002", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => "tok", fetchFn, baseUrl: "https://sync.test",
    })).rejects.toThrow(/403/)
  })

  it("throws if getToken returns null", async () => {
    const fetchFn = vi.fn()
    await expect(uploadSourceOriginal({
      projectId: "p1", fileId: "f1", artifactId: "01900000-0000-7000-8000-000000000003", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => null, fetchFn, baseUrl: "https://sync.test",
    })).rejects.toThrow(/token/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("rejects an oversized artifact before requesting a token or making a request", async () => {
    const fetchFn = vi.fn()
    const getToken = vi.fn(async () => "tok")
    const oversized = new ArrayBuffer(0)
    Object.defineProperty(oversized, "byteLength", { value: 95 * 1024 * 1024 + 1 })
    await expect(uploadSourceOriginal({
      projectId: "p1",
      fileId: "f1",
      artifactId: "01900000-0000-7000-8000-000000000003",
      bytes: oversized,
      format: "paratext-project",
      getToken,
      fetchFn,
      baseUrl: "https://sync.test",
    })).rejects.toThrow(/95 MB/)
    expect(getToken).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // Intent: a transient R2/network hiccup during import must not abort the whole
  // import — the PUT is idempotent, so retry and finish, uploading exactly once.
  it("retries a transient 500 then succeeds without double-uploading", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await uploadSourceOriginal({
      projectId: "p1", fileId: "f1", artifactId: "01900000-0000-7000-8000-000000000004", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => "tok", fetchFn, baseUrl: "https://sync.test",
      retryDelaysMs: [0, 0],
    })
    // One failed attempt + one success, then it stops: no double-write after the
    // 200, and it didn't give up on the transient 500.
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const responses = await Promise.all(
      fetchFn.mock.results.map((r) => r.value as Promise<Response>),
    )
    expect(responses.filter((res) => res.ok)).toHaveLength(1)
  })

  it("does not retry a non-retryable 403", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }))
    await expect(uploadSourceOriginal({
      projectId: "p1", fileId: "f1", artifactId: "01900000-0000-7000-8000-000000000005", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => "tok", fetchFn, baseUrl: "https://sync.test",
      retryDelaysMs: [0, 0],
    })).rejects.toThrow(/403/)
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("sends package preservation metadata without replacing the source sidecar", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await uploadSourceOriginal({
      projectId: "p1",
      fileId: "f1",
      artifactId: "01900000-0000-7000-8000-000000000006",
      artifactName: "My Project.zip",
      bytes: new ArrayBuffer(3),
      format: "paratext-project",
      bindingRole: "support",
      memberPath: "My Project/01GEN.SFM",
      profileId: "builtin:paratext-project",
      profileVersion: "1",
      fidelity: "preserved-only",
      updateSourceSidecar: false,
      getToken: async () => "tok",
      fetchFn,
      baseUrl: "https://sync.test",
    })

    const [, init] = fetchFn.mock.calls[0]
    expect(init.headers).toMatchObject({
      "X-Source-Format": "paratext-project",
      "X-Artifact-Name": "My%20Project.zip",
      "X-Artifact-Binding-Role": "support",
      "X-Artifact-Member-Path": "My%20Project%2F01GEN.SFM",
      "X-Artifact-Profile-Id": "builtin:paratext-project",
      "X-Artifact-Profile-Version": "1",
      "X-Artifact-Fidelity": "preserved-only",
      "X-Update-Source-Sidecar": "false",
    })
  })
})

describe("bindSourceArtifact", () => {
  it("binds an existing package artifact to another file", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await bindSourceArtifact({
      projectId: "p1",
      fileId: "f2",
      artifactId: "01900000-0000-7000-8000-000000000006",
      memberPath: "My Project/02EXO.SFM",
      profileId: "builtin:paratext-project",
      profileVersion: "1",
      fidelity: "preserved-only",
      getToken: async () => "tok",
      fetchFn,
      baseUrl: "https://sync.test",
    })

    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://sync.test/api/v1/projects/p1/files/f2/source-bindings")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({
      artifactId: "01900000-0000-7000-8000-000000000006",
      bindingRole: "support",
      memberPath: "My Project/02EXO.SFM",
      profileId: "builtin:paratext-project",
      profileVersion: "1",
      fidelity: "preserved-only",
    })
  })

  it("reports binding failures", async () => {
    await expect(bindSourceArtifact({
      projectId: "p1",
      fileId: "f2",
      artifactId: "01900000-0000-7000-8000-000000000006",
      profileId: "builtin:paratext-project",
      profileVersion: "1",
      fidelity: "preserved-only",
      getToken: async () => "tok",
      fetchFn: vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
      baseUrl: "https://sync.test",
    })).rejects.toThrow(/404.*missing/)
  })
})
