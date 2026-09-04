// Side-effect entry: must be the first import in kokoro-worker.ts so
// ReadableStream async-iteration and the Node-marker strip run before
// phonemizer's gzip unpack IIFE (dynamic import of kokoro-js).
import { ensureBrowserPhonemizerEnv } from "./phonemizer-browser-env"

ensureBrowserPhonemizerEnv()
