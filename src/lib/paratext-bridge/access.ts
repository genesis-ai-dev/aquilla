// ProjectUserAccess.xml: who may edit which books and chapters. Aquilla checks
// this BEFORE writing anything; Send/Receive would otherwise reject the change
// later, after the user has already done the work.
//
// Shape (Paratext 9):
//   <ProjectUserAccess PeerSharing="true">
//     <User UserName="Ryder Wishart" FirstUser="true" UnregisteredUser="false">
//       <Role>Administrator</Role>          Administrator | Translator | Consultant | Observer
//       <AllBooks>true</AllBooks>
//       <Books><Book Id="MAT" Chapters="1-5,7" /> … </Books>
//       <Permissions>…</Permissions>
//     </User>
//   </ProjectUserAccess>
//
// Regex parsing, like src/lib/parsers/paratext.ts: the file is flat and small.

export type ParatextRole = "Administrator" | "Translator" | "Consultant" | "Observer" | string

export interface BookAccess {
  book: string
  /** Chapter ranges the user may edit; empty = every chapter. */
  chapters: { from: number; to: number }[]
}

export interface UserAccess {
  userName: string
  role: ParatextRole
  allBooks: boolean
  books: BookAccess[]
}

export interface ProjectUserAccess {
  users: UserAccess[]
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? decodeXml(m[1]) : undefined
}

function decodeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function parseChapterRanges(spec: string | undefined): { from: number; to: number }[] {
  if (!spec) return []
  const out: { from: number; to: number }[] = []
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const from = Number(m[1])
    out.push({ from, to: m[2] ? Number(m[2]) : from })
  }
  return out
}

export function parseProjectUserAccess(xml: string): ProjectUserAccess {
  const users: UserAccess[] = []
  for (const um of xml.matchAll(/<User\b([^>]*)>([\s\S]*?)<\/User>/g)) {
    const head = um[1]
    const body = um[2]
    const userName = attr(`<User ${head}>`, "UserName") ?? ""
    const role = body.match(/<Role>([^<]*)<\/Role>/)?.[1]?.trim() ?? ""
    const allBooks = /<AllBooks>\s*true\s*<\/AllBooks>/i.test(body)
    const books: BookAccess[] = []
    for (const bm of body.matchAll(/<Book\b([^>]*)\/>/g)) {
      const tag = `<Book ${bm[1]}>`
      const book = attr(tag, "Id")
      if (!book) continue
      books.push({ book: book.toUpperCase(), chapters: parseChapterRanges(attr(tag, "Chapters")) })
    }
    users.push({ userName, role, allBooks, books })
  }
  return { users }
}

export type EditDenial =
  | "unknown-user"      // the registered user is not a member of this project
  | "read-only-role"    // Consultant / Observer never edit text
  | "book-not-granted"  // Translator without this book
  | "chapter-not-granted"

/** May `userName` edit `book` chapter `chapter`? `null` means yes. */
export function editDenial(access: ProjectUserAccess, userName: string, book: string, chapter: number): EditDenial | null {
  const user = access.users.find((u) => u.userName === userName)
  if (!user) return "unknown-user"
  if (user.role === "Consultant" || user.role === "Observer") return "read-only-role"
  if (user.role === "Administrator" || user.allBooks) return null
  const grant = user.books.find((b) => b.book === book.toUpperCase())
  if (!grant) return "book-not-granted"
  if (grant.chapters.length === 0) return null
  return grant.chapters.some((r) => chapter >= r.from && chapter <= r.to) ? null : "chapter-not-granted"
}
