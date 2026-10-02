import { afterEach, describe, expect, it, vi } from "vitest"
import { createMediaFileCommit } from "../import"
import { consumeMediaImportSeed } from "../audio/auto-transcribe"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("createMediaFileCommit", () => {
  it.each([
    { type: "audio", name: "clip.mp3", mime: "audio/mpeg" },
    { type: "video", name: "clip.mp4", mime: "video/mp4" },
  ] as const)("commits original $type with a YouTube picture and an ASR seed", async ({ type, name, mime }) => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (url, init: RequestInit) => {
      requests.push({ url: String(url), init })
      return Response.json({ accepted: 1 })
    }))

    const createElement = document.createElement.bind(document)
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
      const element = createElement(tag, options)
      if (tag === "audio" || tag === "video") {
        Object.defineProperty(element, "duration", { value: 2 })
        Object.defineProperty(element, "src", {
          set() {
            queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")))
          },
        })
      }
      return element
    })

    const media = new File(["original bytes"], name, { type: mime })
    const result = await createMediaFileCommit(media, type, {
      projectId: "p1",
      author: "dev",
      getToken: async () => "token",
      mediaPictureUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    })()

    const posts = requests
      .filter((request) => request.init.method === "POST")
      .map((request) => JSON.parse(String(request.init.body)))

    const lastPost = posts.at(-1)
    expect(lastPost.video.coreMediaUrl).toBe("https://www.youtube.com/watch?v=M7lc1UVf-VE")

    expect(lastPost.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: expect.stringMatching(/^frontier-audio:\/\//),
        }),
      ]),
    )

    const puts = requests.filter((request) => request.init.method === "PUT")
    expect(puts).toHaveLength(1)
    const blobPut = puts.find((request) => !request.url.endsWith("/source"))
    expect(blobPut?.init.body).toBe(media)

    const seed = consumeMediaImportSeed(result.id)
    expect(seed).toBeDefined()
    expect(seed!.cells.length).toBeGreaterThan(0)
    const cell = seed!.cells[0]
    expect(cell.attachments![cell.selectedAudioId!].url).toBe(lastPost.attachments[0].url)
    expect(requests.some(request => request.url.includes("youtube.com"))).toBe(false)
  })

  it("retries on 400 for complete && video, succeeds on retry, and idempotent file.create and media PUT", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    let attemptCount = 0

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit) => {
        requests.push({ url: String(url), init })
        const body = init.method === "POST" ? JSON.parse(String(init.body)) : {}

        if (
          init.method === "POST" &&
          body.complete &&
          body.video &&
          attemptCount === 0
        ) {
          attemptCount++
          return new Response(JSON.stringify({ error: "temporary failure" }), {
            status: 400,
          })
        }

        return Response.json({ accepted: 1 })
      }),
    )

    const createElement = document.createElement.bind(document)
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
      const element = createElement(tag, options)
      if (tag === "audio" || tag === "video") {
        Object.defineProperty(element, "duration", { value: 2 })
        Object.defineProperty(element, "src", {
          set() {
            queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")))
          },
        })
      }
      return element
    })

    const media = new File(["audio bytes"], "clip.mp3", { type: "audio/mpeg" })

    const commit = createMediaFileCommit(media, "audio", {
      projectId: "p1",
      author: "dev",
      getToken: async () => "token",
      mediaPictureUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    })
    await expect(commit()).rejects.toThrow("400")
    const result = await commit()
    expect(await commit()).toBe(result)

    const fileCreatePosts = requests
      .filter((request) => request.init.method === "POST")
      .map((request) => JSON.parse(String(request.init.body)))
      .filter((body) => body.file)

    expect(fileCreatePosts).toHaveLength(1)

    const mediaPuts = requests.filter(
      (request) =>
        request.init.method === "PUT" && !request.url.endsWith("/source"),
    )
    expect(mediaPuts).toHaveLength(1)

    const successPosts = requests
      .filter((request) => request.init.method === "POST")
      .map((request) => JSON.parse(String(request.init.body)))
      .filter((body) => body.complete && body.video)

    expect(successPosts).toHaveLength(2)
    expect(successPosts[0].video.id).toBeDefined()
    expect(successPosts[1].video.id).toBe(successPosts[0].video.id)
    expect(successPosts[1].publishEventId).toBe(successPosts[0].publishEventId)

    const seed = consumeMediaImportSeed(result.id)
    expect(seed).toBeDefined()
  })
})
