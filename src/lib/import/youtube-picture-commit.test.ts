import { afterEach, describe, expect, it, vi } from "vitest"
import { createYouTubeCaptionCommit } from "./youtube-caption-commit"
import { prepareYouTubePictureImport } from "./youtube-captions"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("YouTube picture import", () => {
  it("commits an empty timeline and publishes its linked picture", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (url, init: RequestInit) => {
      requests.push({ url: String(url), init })
      return Response.json({ accepted: 1 })
    }))

    const prepared = prepareYouTubePictureImport({
      url: "https://youtu.be/M7lc1UVf-VE",
      name: "My picture",
    })

    const result = await createYouTubeCaptionCommit(prepared, {
      projectId: "p1",
      author: "dev",
      getToken: async () => "token",
    })()

    const posts = requests
      .filter(request => request.init.method === "POST")
      .map(request => JSON.parse(String(request.init.body)))

    expect(posts[0]).toMatchObject({
      file: expect.objectContaining({ name: "My picture", orderedBy: "time" }),
      cells: [],
    })

    const lastPost = posts.at(-1)
    expect(lastPost).toMatchObject({
      video: expect.objectContaining({
        coreMediaUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      }),
      complete: true,
    })
    expect(lastPost.fileId).toBe(posts[0].fileId)

    expect(result.ref).toMatchObject({
      cellCount: 0,
      type: "video",
      coreMediaUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    })

    const puts = requests.filter(request => request.init.method === "PUT")
    expect(puts).toHaveLength(0)

    const youtubeRequests = requests.filter(request =>
      String(request.url).includes("youtube")
    )
    expect(youtubeRequests).toHaveLength(0)
  })

  it("validates URL format", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ accepted: 1 })))

    expect(() =>
      prepareYouTubePictureImport({
        url: "invalid-url",
        name: "My picture",
      })
    ).toThrow()
  })

  it("validates non-blank name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ accepted: 1 })))

    expect(() =>
      prepareYouTubePictureImport({
        url: "https://youtu.be/M7lc1UVf-VE",
        name: "",
      })
    ).toThrow()
  })
})
