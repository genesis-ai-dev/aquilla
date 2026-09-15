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

describe("asReadonlyR2", () => {
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
