import {
  runIdmlCorpusConformance,
  type IdmlCorpusConformanceReport,
  type IdmlCorpusLoader,
} from "./corpus.js"

const corpusRoot = new URL("/fixtures/", globalThis.location.origin)

const loader: IdmlCorpusLoader = {
  async loadBytes(path) {
    const response = await fetch(new URL(path, corpusRoot))
    if (!response.ok) throw new Error(`Could not load browser fixture ${path}`)
    return new Uint8Array(await response.arrayBuffer())
  },
  async loadJson(path) {
    const response = await fetch(new URL(path, corpusRoot))
    if (!response.ok) throw new Error(`Could not load browser fixture ${path}`)
    return response.json() as Promise<unknown>
  },
}

export function runBrowserCorpusConformance(): Promise<IdmlCorpusConformanceReport> {
  return runIdmlCorpusConformance(loader, "chromium")
}
