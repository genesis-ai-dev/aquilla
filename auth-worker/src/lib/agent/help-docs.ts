// In-app help for the translation agent (AQU-2582): the docs tool's `help`
// topics. `help` lists the pages of the public help site, `help/<path>` returns
// one page as Markdown. It goes through the shared reader (db/shared/help-site),
// which fetches only pages listed in the site's index and never throws, so a
// caller's topic string is never turned into a URL and an outage comes back as
// text the model can relay.

import {
  helpIndex,
  helpPage,
  helpSiteBase,
  normalizeHelpPath,
  type HelpSiteEnv,
} from "../../../../db/shared/help-site"

/** A page longer than this many characters is cut and says so. */
export const HELP_PAGE_MAX_CHARS = 40_000

/** The changelog is about 220,000 characters: the in-app agent never reads it. */
const CHANGELOG_PATH = "/changelog/"

export function isHelpTopic(topic: string): boolean {
  const t = topic.trim().toLowerCase()
  return t === "help" || t.startsWith("help/")
}

interface ListedPage {
  path: string
  title: string
  description: string
  section: string
}

function topicPath(path: string): string {
  return `help/${path.replace(/^\/+|\/+$/g, "")}`
}

function unreachable(base: string): { ok: false; text: string } {
  return {
    ok: false,
    text: `could not reach the help pages. Tell the user you could not look this up and that the help site is at ${base}`,
  }
}

async function helpList(env: HelpSiteEnv): Promise<{ ok: boolean; text: string }> {
  const result = await helpIndex(env)
  if (!result.ok) return unreachable(helpSiteBase(env))
  const pages = (result.body.pages as ListedPage[]).filter((p) => p.path.toLowerCase() !== CHANGELOG_PATH)
  const sections: string[] = []
  const bySection = new Map<string, ListedPage[]>()
  for (const p of pages) {
    const name = p.section || "Other"
    if (!bySection.has(name)) {
      bySection.set(name, [])
      sections.push(name)
    }
    bySection.get(name)!.push(p)
  }
  const lines: string[] = []
  for (const name of sections) {
    lines.push(`## ${name}`)
    for (const p of bySection.get(name)!) {
      lines.push(`${topicPath(p.path)} — ${p.title}${p.description ? `: ${p.description}` : ""}`)
    }
  }
  lines.push("", 'Fetch a page with docs({topic:"help/<path>"}).')
  return { ok: true, text: lines.join("\n") }
}

async function helpOne(env: HelpSiteEnv, rest: string): Promise<{ ok: boolean; text: string }> {
  const base = helpSiteBase(env)
  let host: string
  try {
    host = new URL(base).host
  } catch {
    return unreachable(base)
  }
  if (normalizeHelpPath(rest, host)?.toLowerCase() === CHANGELOG_PATH) {
    return {
      ok: false,
      text: `the changelog is too long to read here. Give the user its address instead: ${base}${CHANGELOG_PATH}`,
    }
  }
  const result = await helpPage(env, rest)
  if (!result.ok) {
    if (result.code === "not_found") {
      return { ok: false, text: `unknown help page "${rest}". Call docs({topic:"help"}) for the list of pages.` }
    }
    return unreachable(base)
  }
  const { title, url } = result.body as { title: string; url: string }
  let markdown = String(result.body.markdown ?? "")
  let cut = ""
  if (markdown.length > HELP_PAGE_MAX_CHARS) {
    markdown = markdown.slice(0, HELP_PAGE_MAX_CHARS)
    cut = `\n\n[This page was cut short. The rest is at ${url}]`
  }
  return {
    ok: true,
    text: `# ${title}\n${url}\n\n${markdown}${cut}\n\nAnswer from this page and give the user the page URL: ${url}`,
  }
}

/** The `help` topic. Same result shape as getCookbook. */
export async function getHelpDocs(env: HelpSiteEnv, topic: string): Promise<{ ok: boolean; text: string }> {
  const rest = topic.trim().slice("help/".length).trim()
  // "help" and a bare "help/" both mean the list.
  if (rest === "") return helpList(env)
  return helpOne(env, rest)
}
