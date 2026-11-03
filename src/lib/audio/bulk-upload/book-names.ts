// AQU-981: every reasonable way a recording's file name can name a Bible book.
//
// Bulk upload reads the book out of names somebody else chose — a phone, a
// recording studio, a partner's own folder scheme — so it has to know more
// spellings than the app's own book table (file-labeling/bible-book-names.ts),
// which deliberately guesses nothing beyond codes and English names. Here:
//
//   - USFM codes ("GEN", "1SA"), any case;
//   - English names and the short forms people actually type ("Gen", "Gn",
//     "1 Sam", "1Sam", "I Samuel", "First Samuel", "Ps", "Psalm", "Matt");
//   - Chinese Union Version names and their one- and two-character short forms,
//     simplified and traditional ("创世记", "創世記", "创", "撒上") — the
//     partner this was built for names files this way;
//   - and, added at run time, whatever the PROJECT'S OWN files call their books
//     (file names, and the \h \toc \mt lines of a Bible file) — see
//     `BookNameIndex.addProjectName`.
//
// A name is compared by `bookKey`: case, spaces, dots, hyphens and underscores
// don't count, and a leading ordinal ("I", "II", "First", "2nd") is read as
// its digit. Short Latin forms of one or two letters ("Ge", "Ps", "Mt") are
// only trusted right before the chapter number — see `isWeakAlias` — because
// on their own they are ordinary words.

/** [USFM code, English name, …other spellings]. Canonical (Protestant) order. */
const BOOKS: ReadonlyArray<readonly [string, string, ...string[]]> = [
  ["GEN", "Genesis", "Gen", "Ge", "Gn"],
  ["EXO", "Exodus", "Exod", "Exo", "Ex"],
  ["LEV", "Leviticus", "Lev", "Le", "Lv"],
  ["NUM", "Numbers", "Num", "Nu", "Nm", "Nb"],
  ["DEU", "Deuteronomy", "Deut", "Dt", "De"],
  ["JOS", "Joshua", "Josh", "Jsh"],
  ["JDG", "Judges", "Judg", "Jdgs", "Jg"],
  ["RUT", "Ruth", "Rth", "Ru"],
  ["1SA", "1 Samuel", "1 Sam", "1 Sm", "1 Sa", "1 S"],
  ["2SA", "2 Samuel", "2 Sam", "2 Sm", "2 Sa", "2 S"],
  ["1KI", "1 Kings", "1 Kgs", "1 Kin", "1 Ki", "1 K"],
  ["2KI", "2 Kings", "2 Kgs", "2 Kin", "2 Ki", "2 K"],
  ["1CH", "1 Chronicles", "1 Chron", "1 Chr", "1 Ch"],
  ["2CH", "2 Chronicles", "2 Chron", "2 Chr", "2 Ch"],
  ["EZR", "Ezra", "Ezr", "Ez"],
  ["NEH", "Nehemiah", "Neh", "Ne"],
  ["EST", "Esther", "Esth", "Es"],
  ["JOB", "Job", "Jb"],
  ["PSA", "Psalms", "Psalm", "Pss", "Psm", "Pslm", "Ps"],
  ["PRO", "Proverbs", "Prov", "Prv", "Pr"],
  ["ECC", "Ecclesiastes", "Eccles", "Eccl", "Ecc", "Ec", "Qoh", "Qoheleth"],
  ["SNG", "Song of Songs", "Song of Solomon", "Song", "Songs", "Sos", "Canticles", "Cant"],
  ["ISA", "Isaiah", "Isa", "Is"],
  ["JER", "Jeremiah", "Jer", "Je", "Jr"],
  ["LAM", "Lamentations", "Lam", "La"],
  ["EZK", "Ezekiel", "Ezek", "Eze"],
  ["DAN", "Daniel", "Dan", "Da", "Dn"],
  ["HOS", "Hosea", "Hos", "Ho"],
  ["JOL", "Joel", "Joe", "Jl"],
  ["AMO", "Amos", "Am"],
  ["OBA", "Obadiah", "Obad", "Ob"],
  ["JON", "Jonah", "Jnh"],
  ["MIC", "Micah", "Mc"],
  ["NAM", "Nahum", "Nah", "Na"],
  ["HAB", "Habakkuk", "Hab", "Hb"],
  ["ZEP", "Zephaniah", "Zeph", "Zp"],
  ["HAG", "Haggai", "Hag", "Hg"],
  ["ZEC", "Zechariah", "Zech", "Zc"],
  ["MAL", "Malachi", "Ml"],
  ["MAT", "Matthew", "Matt", "Mt"],
  ["MRK", "Mark", "Mar", "Mk", "Mr"],
  ["LUK", "Luke", "Luk", "Lk"],
  ["JHN", "John", "Joh", "Jn"],
  ["ACT", "Acts", "Ac"],
  ["ROM", "Romans", "Rom", "Ro", "Rm"],
  ["1CO", "1 Corinthians", "1 Cor", "1 Co"],
  ["2CO", "2 Corinthians", "2 Cor", "2 Co"],
  ["GAL", "Galatians", "Gal", "Ga"],
  ["EPH", "Ephesians", "Ephes", "Eph"],
  ["PHP", "Philippians", "Phil", "Pp"],
  ["COL", "Colossians", "Col"],
  ["1TH", "1 Thessalonians", "1 Thess", "1 Thes", "1 Th"],
  ["2TH", "2 Thessalonians", "2 Thess", "2 Thes", "2 Th"],
  ["1TI", "1 Timothy", "1 Tim", "1 Ti"],
  ["2TI", "2 Timothy", "2 Tim", "2 Ti"],
  ["TIT", "Titus", "Ti"],
  ["PHM", "Philemon", "Philem", "Phlm", "Pm"],
  ["HEB", "Hebrews", "Heb"],
  ["JAS", "James", "Jas", "Jms", "Jm"],
  ["1PE", "1 Peter", "1 Pet", "1 Pt", "1 Pe", "1 P"],
  ["2PE", "2 Peter", "2 Pet", "2 Pt", "2 Pe", "2 P"],
  ["1JN", "1 John", "1 Jhn", "1 Joh", "1 Jn", "1 Jo"],
  ["2JN", "2 John", "2 Jhn", "2 Joh", "2 Jn", "2 Jo"],
  ["3JN", "3 John", "3 Jhn", "3 Joh", "3 Jn", "3 Jo"],
  ["JUD", "Jude", "Jd"],
  ["REV", "Revelation", "Revelations", "Rev", "Rv", "Re", "Apocalypse", "Apoc"],
]

/** Chinese Union Version names, simplified then traditional, then short forms. */
const CHINESE: ReadonlyArray<readonly [string, ...string[]]> = [
  ["GEN", "创世记", "創世記", "创", "創"],
  ["EXO", "出埃及记", "出埃及記", "出"],
  ["LEV", "利未记", "利未記", "利"],
  ["NUM", "民数记", "民數記", "民"],
  ["DEU", "申命记", "申命記", "申"],
  ["JOS", "约书亚记", "約書亞記", "书", "書"],
  ["JDG", "士师记", "士師記", "士"],
  ["RUT", "路得记", "路得記", "得"],
  ["1SA", "撒母耳记上", "撒母耳記上", "撒上"],
  ["2SA", "撒母耳记下", "撒母耳記下", "撒下"],
  ["1KI", "列王纪上", "列王紀上", "王上"],
  ["2KI", "列王纪下", "列王紀下", "王下"],
  ["1CH", "历代志上", "歷代志上", "代上"],
  ["2CH", "历代志下", "歷代志下", "代下"],
  ["EZR", "以斯拉记", "以斯拉記", "拉"],
  ["NEH", "尼希米记", "尼希米記", "尼"],
  ["EST", "以斯帖记", "以斯帖記", "斯"],
  ["JOB", "约伯记", "約伯記", "伯"],
  ["PSA", "诗篇", "詩篇", "诗", "詩"],
  ["PRO", "箴言", "箴"],
  ["ECC", "传道书", "傳道書", "传", "傳"],
  ["SNG", "雅歌", "歌"],
  ["ISA", "以赛亚书", "以賽亞書", "赛", "賽"],
  ["JER", "耶利米书", "耶利米書", "耶"],
  ["LAM", "耶利米哀歌", "哀"],
  ["EZK", "以西结书", "以西結書", "结", "結"],
  ["DAN", "但以理书", "但以理書", "但"],
  ["HOS", "何西阿书", "何西阿書", "何"],
  ["JOL", "约珥书", "約珥書", "珥"],
  ["AMO", "阿摩司书", "阿摩司書", "摩"],
  ["OBA", "俄巴底亚书", "俄巴底亞書", "俄"],
  ["JON", "约拿书", "約拿書", "拿"],
  ["MIC", "弥迦书", "彌迦書", "弥", "彌"],
  ["NAM", "那鸿书", "那鴻書", "鸿", "鴻"],
  ["HAB", "哈巴谷书", "哈巴谷書", "哈"],
  ["ZEP", "西番雅书", "西番雅書", "番"],
  ["HAG", "哈该书", "哈該書", "该", "該"],
  ["ZEC", "撒迦利亚书", "撒迦利亞書", "亚", "亞"],
  ["MAL", "玛拉基书", "瑪拉基書", "玛", "瑪"],
  ["MAT", "马太福音", "馬太福音", "太"],
  ["MRK", "马可福音", "馬可福音", "可"],
  ["LUK", "路加福音", "路"],
  ["JHN", "约翰福音", "約翰福音", "约", "約"],
  ["ACT", "使徒行传", "使徒行傳", "徒"],
  ["ROM", "罗马书", "羅馬書", "罗", "羅"],
  ["1CO", "哥林多前书", "哥林多前書", "林前"],
  ["2CO", "哥林多后书", "哥林多後書", "林后", "林後"],
  ["GAL", "加拉太书", "加拉太書", "加"],
  ["EPH", "以弗所书", "以弗所書", "弗"],
  ["PHP", "腓立比书", "腓立比書", "腓"],
  ["COL", "歌罗西书", "歌羅西書", "西"],
  ["1TH", "帖撒罗尼迦前书", "帖撒羅尼迦前書", "帖前"],
  ["2TH", "帖撒罗尼迦后书", "帖撒羅尼迦後書", "帖后", "帖後"],
  ["1TI", "提摩太前书", "提摩太前書", "提前"],
  ["2TI", "提摩太后书", "提摩太後書", "提后", "提後"],
  ["TIT", "提多书", "提多書", "多"],
  ["PHM", "腓利门书", "腓利門書", "门", "門"],
  ["HEB", "希伯来书", "希伯來書", "来", "來"],
  ["JAS", "雅各书", "雅各書", "雅"],
  ["1PE", "彼得前书", "彼得前書", "彼前"],
  ["2PE", "彼得后书", "彼得後書", "彼后", "彼後"],
  ["1JN", "约翰一书", "約翰一書", "约一", "約一"],
  ["2JN", "约翰二书", "約翰二書", "约二", "約二"],
  ["3JN", "约翰三书", "約翰三書", "约三", "約三"],
  ["JUD", "犹大书", "猶大書", "犹", "猶"],
  ["REV", "启示录", "啟示錄", "启", "啟"],
]

/** Canonical order, for sorting and for the book numbers some schemes prefix. */
export const BOOK_CODES: readonly string[] = BOOKS.map(([code]) => code)

const ENGLISH_NAME = new Map(BOOKS.map(([code, name]) => [code, name]))

/** "Genesis" for "GEN"; the code itself for anything unknown. */
export function englishBookName(code: string): string {
  return ENGLISH_NAME.get(code) ?? code
}

const ORDINAL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(iii|third|3rd)(?=\p{L})/u, "3"],
  [/^(ii|second|2nd)(?=\p{L})/u, "2"],
  [/^(i|first|1st)(?=\p{L})/u, "1"],
]

/**
 * How a book name is compared. NFKC (full-width letters and digits become
 * ordinary ones), lower case, and no spaces, dots, hyphens or underscores —
 * then a leading ordinal word or Roman numeral becomes its digit, so "I
 * Samuel", "First Samuel" and "1 Samuel" are one key. Only before a word: a
 * bare "I" is not a book.
 */
export function bookKey(value: string): string {
  const flat = value.normalize("NFKC").toLowerCase().replace(/[\s._\-'’]+/gu, "")
  for (const [re, digit] of ORDINAL_WORDS) {
    const match = re.exec(flat)
    if (!match) continue
    const rest = flat.slice(match[0].length)
    // "Is" (Isaiah) must not become "1 S" (1 Samuel): a Roman numeral counts
    // only before a name of three letters or more, and only when that leaves a
    // known book behind. "First"/"2nd" are unambiguous words.
    const roman = /^i+$/.test(match[0])
    if ((!roman || rest.length >= 3) && BUILTIN.has(`${digit}${rest}`)) return `${digit}${rest}`
  }
  return flat
}

/** Built-in keys → code. `bookKey` consults this before it is complete, so it
 *  is filled with raw keys first (none of which start with an ordinal word). */
const BUILTIN = new Map<string, string>()
const WEAK = new Set<string>()
for (const [code, ...names] of BOOKS) {
  for (const name of [code, ...names]) {
    const key = name.normalize("NFKC").toLowerCase().replace(/[\s._\-'’]+/gu, "")
    if (!BUILTIN.has(key)) BUILTIN.set(key, code)
    // One or two Latin letters with nothing else ("Ge", "Ps", "1 S" → "1s"
    // has a digit and stays strong) are ordinary words as often as books.
    if (/^\p{L}{1,2}$/u.test(key) && name !== code) WEAK.add(key)
  }
}
for (const [code, ...names] of CHINESE) {
  for (const name of names) {
    const key = name.normalize("NFKC")
    if (!BUILTIN.has(key)) BUILTIN.set(key, code)
    // A one-character short form ("可", "出") is an everyday character too.
    if ([...key].length === 1) WEAK.add(key)
  }
}

/** True for a short Latin form ("Ge", "Ps") that is a book only before a number. */
export function isWeakAlias(key: string): boolean {
  return WEAK.has(key)
}

/**
 * The lookup bulk upload uses: the built-in spellings plus the project's own.
 * A project name wins over a built-in one with the same key, because it is
 * what this project calls the book.
 */
export class BookNameIndex {
  private readonly project = new Map<string, string>()
  private readonly builtins: boolean

  /** `builtins: false` knows only what `addProjectName` teaches it. */
  constructor(opts: { builtins?: boolean } = {}) {
    this.builtins = opts.builtins ?? true
  }

  /** Teach the index a name the project uses for a book ("创世记", "Genèse"). */
  addProjectName(name: string, code: string): void {
    const key = bookKey(name)
    if (key.length === 0 || /^\d+$/.test(key)) return
    this.project.set(key, code)
  }

  /** The code for a name, or null. `weakOk` admits the one- and two-letter forms. */
  lookup(name: string, weakOk: boolean): { code: string; fromProject: boolean } | null {
    const key = bookKey(name)
    const own = this.project.get(key)
    if (own) return { code: own, fromProject: true }
    if (!this.builtins) return null
    const code = BUILTIN.get(key)
    if (!code) return null
    if (!weakOk && isWeakAlias(key)) return null
    return { code, fromProject: false }
  }
}
