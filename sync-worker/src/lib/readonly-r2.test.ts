import { describe, expect, it } from "vitest"
import { asReadonlyR2 } from "./readonly-r2"

function makeFakeBucket() {
  return {
    get: async (key: string) => ({ key, body: "stub" }),
    head: async (key: string) => ({ key }),
    list: async () => ({ objects: [], truncated: false }),
    put: async () => {
      throw new Error("real put should never be reached in this test")
    },
    delete: async () => {
      throw new Error("real delete should never be reached in this test")
    },
    createMultipartUpload: async () => {
      throw new Error("real createMultipartUpload should never be reached in this test")
    },
  }
}

// Stand-in for the native R2Bucket binding. workerd bindings are host objects
// whose methods verify the receiver's brand, exactly as private fields do: a
// method invoked with a Proxy as `this` throws instead of running. The plain
// closure fake above cannot reproduce that, which is how the receiver bug
// reached production (AQU-680).
class NativeLikeBucket {
  #objects = new Map<string, string>([["k", "stub"]])

  async get(key: string) {
    return this.#objects.has(key) ? { key, body: this.#objects.get(key) } : null
  }

  async head(key: string) {
    return this.#objects.has(key) ? { key } : null
  }

  async list() {
    return { objects: [...this.#objects.keys()].map((key) => ({ key })), truncated: false }
  }

  async put() {
    throw new Error("real put should never be reached in this test")
  }

  async delete() {
    throw new Error("real delete should never be reached in this test")
  }

  async createMultipartUpload() {
    throw new Error("real createMultipartUpload should never be reached in this test")
  }
}

describe("asReadonlyR2", () => {
  it("invokes host-object reads with the real bucket as receiver", async () => {
    const wrapped = asReadonlyR2(new NativeLikeBucket() as unknown as R2Bucket)
    expect(await wrapped.get("k")).toEqual({ key: "k", body: "stub" })
    expect(await wrapped.head("missing")).toBeNull()
    expect(await wrapped.list()).toEqual({ objects: [{ key: "k" }], truncated: false })
  })

  it("returns bound reads so a detached method still targets the bucket", async () => {
    const { get, list } = asReadonlyR2(new NativeLikeBucket() as unknown as R2Bucket)
    expect(await get("k")).toEqual({ key: "k", body: "stub" })
    expect(await list()).toEqual({ objects: [{ key: "k" }], truncated: false })
  })

  it("still rejects writes on a host-object bucket", async () => {
    const wrapped = asReadonlyR2(new NativeLikeBucket() as unknown as R2Bucket)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising a method the readonly type deliberately omits
    await expect((wrapped as any).put("k", "v")).rejects.toThrow(/readonly R2 binding/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising a method the readonly type deliberately omits
    await expect((wrapped as any).delete("k")).rejects.toThrow(/readonly R2 binding/)
  })

  it("passes reads through to the underlying bucket", async () => {
    const wrapped = asReadonlyR2(makeFakeBucket() as unknown as R2Bucket)
    expect(await wrapped.get("k")).toEqual({ key: "k", body: "stub" })
    expect(await wrapped.head("k")).toEqual({ key: "k" })
    expect(await wrapped.list()).toEqual({ objects: [], truncated: false })
  })

  it("throws instead of calling through on put", async () => {
    const wrapped = asReadonlyR2(makeFakeBucket() as unknown as R2Bucket)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising a method the readonly type deliberately omits
    await expect((wrapped as any).put("k", "v")).rejects.toThrow(/readonly R2 binding/)
  })

  it("throws instead of calling through on delete", async () => {
    const wrapped = asReadonlyR2(makeFakeBucket() as unknown as R2Bucket)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising a method the readonly type deliberately omits
    await expect((wrapped as any).delete("k")).rejects.toThrow(/readonly R2 binding/)
  })

  it("throws instead of calling through on createMultipartUpload", async () => {
    const wrapped = asReadonlyR2(makeFakeBucket() as unknown as R2Bucket)
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising a method the readonly type deliberately omits
      (wrapped as any).createMultipartUpload("k"),
    ).rejects.toThrow(/readonly R2 binding/)
  })
})
