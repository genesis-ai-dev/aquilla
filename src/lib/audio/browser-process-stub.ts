// Worker-only `process` stand-in. phonemizer treats a string
// `process.versions.node` as "unpack via Node fs", which leaves the
// espeak identifier set empty in the browser.
const browserProcess = {
  browser: true,
  argv: [] as string[],
  env: {} as Record<string, string | undefined>,
  versions: {} as { node?: string },
  on() {
    return browserProcess
  },
}

export default browserProcess
