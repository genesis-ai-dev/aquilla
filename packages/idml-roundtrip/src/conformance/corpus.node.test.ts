import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  runIdmlCorpusConformance,
  type IdmlCorpusLoader,
} from "./corpus.js"

const corpusRoot = resolve(import.meta.dirname, "../../fixtures")

const loader: IdmlCorpusLoader = {
  async loadBytes(path) {
    return new Uint8Array(await readFile(resolve(corpusRoot, path)))
  },
  async loadJson(path) {
    return JSON.parse(await readFile(resolve(corpusRoot, path), "utf8")) as unknown
  },
}

describe("generated IDML corpus in Node", () => {
  it("passes package, security, metadata, and full round-trip conformance", async () => {
    await expect(runIdmlCorpusConformance(loader, "node")).resolves.toEqual({
      validPackages: 2,
      hostilePackagesRejected: 10,
      metadataContracts: 3,
      featureUnitCount: 14,
      translatedUnitCount: 14,
      runtime: "node",
    })
  })
})
