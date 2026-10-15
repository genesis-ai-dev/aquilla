import type { ContentAdapter } from "./adapter.ts"
import { idmlAdapter } from "./idml/index.ts"

const adapters: ContentAdapter[] = [idmlAdapter]

export const registerAdapter = (a: ContentAdapter): void => {
  if (!adapters.some((x) => x.format === a.format)) adapters.push(a)
}

export const adapterFor = (path: string): ContentAdapter | undefined => {
  const lower = path.toLowerCase()
  return adapters.find((a) => a.extensions.some((ext) => lower.endsWith(ext)))
}

export const allAdapters = (): readonly ContentAdapter[] => adapters
