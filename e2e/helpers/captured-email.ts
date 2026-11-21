/** Mail the local auth-worker "sent" during an E2E run.
 *
 * Miniflare's `send_email` binding delivers nothing. It writes each message
 * under `auth-worker/.wrangler/tmp/email/…/email-text/<id>.txt`. That folder
 * is runtime output: it does not exist until the first email of a checkout is
 * written, and wrangler removes its files when a stack exits (every shard's
 * auth-worker shares the one folder).
 *
 * A spec waiting for its email polls these readers. A throw inside
 * `expect.poll` fails the poll at once instead of retrying, so "not there
 * (yet, or any more)" has to read as "no mail", never as an error.
 */
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIL_ROOT = path.resolve(__dirname, "../../auth-worker/.wrangler/tmp/email")

/** Only a missing path is "no mail". Any other fs error still fails the test. */
async function unlessMissing<T>(read: Promise<T>, whenMissing: T): Promise<T> {
  try {
    return await read
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return whenMissing
    throw error
  }
}

/** Every captured plain-text body, as a path relative to the mail folder. */
export async function capturedEmailFiles(): Promise<string[]> {
  const entries = await unlessMissing(readdir(MAIL_ROOT, { recursive: true }), [])
  return entries.filter((entry) => entry.includes("email-text/") && entry.endsWith(".txt"))
}

/** Text of each captured email, skipping the files in `alreadySeen`
 * (a `capturedEmailFiles()` snapshot taken before the action that sends). */
export async function capturedEmailTexts(
  alreadySeen: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const texts: string[] = []
  for (const file of await capturedEmailFiles()) {
    if (alreadySeen.has(file)) continue
    const text = await unlessMissing(readFile(path.join(MAIL_ROOT, file), "utf8"), null)
    if (text !== null) texts.push(text)
  }
  return texts
}
