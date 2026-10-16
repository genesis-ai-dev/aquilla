/**
 * BibleEntityLinkSection (AQU-1693) — on the term detail page, the Bible
 * person, place or group this concept names: "Link to a Bible person, place or
 * group", and Change / Unlink once linked. Voices and Who's Who then name that
 * entity with the concept's preferred rendering.
 *
 * The caller renders it only while `isBibleEntityLinkAvailable(project)`: this
 * device's Bible data experiment and the project's Bible data switch. The
 * concept editor is not a Bible-open surface, so no open Bible is needed.
 *
 * The pack has people per book, not one list, so the picker lists one book at
 * a time, starting with `defaultBook` (where the term first occurs). It reads
 * the pack only once something needs it: the picker is open, or the concept is
 * linked and the section shows the linked name. The pack client keeps one
 * book in memory, so picking from another book here drops the editor's book
 * from memory; it comes back from IndexedDB.
 */

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLabelText } from "@/components/bible-data/useEntityLabels"
import { linkCandidates, type LinkCandidate } from "@/lib/bible-data/entity-link"
import { loadLayer, loadManifest } from "@/lib/bible-data/pack-client"
import type { BkpEntity, BkpEntityId } from "@/lib/bible-data/pack-types"
import { compareByCanonicalBookOrder, getBookName } from "@/lib/file-labeling/bible-book-names"
import { useFormat } from "@/lib/i18n/format"
import { useT } from "@/lib/i18n/I18nProvider"
import type { Concept, ConceptExternalIds } from "@/lib/terminology/types"

interface Props {
  concept: Concept
  /** May this person change the link (the termbase floor: `term.update` is gated there). */
  canEdit: boolean
  /** The book to list first, e.g. the book of the term's first occurrence. */
  defaultBook?: string
  onChange: (conceptId: string, externalIds: ConceptExternalIds | undefined) => void | Promise<void>
}

/** One book's people layer as loaded: `entities` is null when it did not load. */
interface LoadedBook {
  book: string
  entities: Readonly<Record<BkpEntityId, BkpEntity>> | null
}

export function BibleEntityLinkSection({ concept, canEdit, defaultBook, onChange }: Props) {
  const t = useT()
  const fmt = useFormat()
  const pick = useLabelText()
  const linked = concept.externalIds?.acai ?? null
  const [picking, setPicking] = useState(false)
  const [books, setBooks] = useState<readonly string[] | null>(null)
  const [book, setBook] = useState<string | null>(null)
  const [manifestFailed, setManifestFailed] = useState(false)
  const [loaded, setLoaded] = useState<LoadedBook | null>(null)
  const [query, setQuery] = useState("")
  const wanted = picking || linked !== null

  // Which books have people, once something needs the pack.
  useEffect(() => {
    if (!wanted || books) return
    let live = true
    void loadManifest().then((result) => {
      if (!live) return
      if (!result.ok) {
        setManifestFailed(true)
        return
      }
      const withPeople = Object.entries(result.value.books)
        .filter(([, entry]) => entry.layers.includes("people"))
        .map(([code]) => code)
        .sort(compareByCanonicalBookOrder)
      setBooks(withPeople)
      setBook(defaultBook && withPeople.includes(defaultBook) ? defaultBook : (withPeople[0] ?? null))
    })
    return () => {
      live = false
    }
  }, [wanted, books, defaultBook])

  useEffect(() => {
    if (!wanted || !book) return
    let live = true
    void loadLayer("people", book).then((result) => {
      if (live) setLoaded({ book, entities: result.ok ? result.value.entities : null })
    })
    return () => {
      live = false
    }
  }, [wanted, book])

  const current = loaded?.book === book ? loaded : null
  const entities = current?.entities ?? null
  const failed = manifestFailed || current?.entities === null
  const loading = !failed && (books === null || (book !== null && current === null))
  const candidates = useMemo(
    () =>
      entities
        ? linkCandidates(entities, [concept.sourceTerm, ...(concept.match?.forms ?? [])], query)
        : { suggested: [], others: [] },
    [entities, concept.sourceTerm, concept.match?.forms, query],
  )

  if (!linked && !canEdit) return null

  const nameOf = (entity: BkpEntity | undefined): string | null => pick(entity?.labels)?.text ?? null
  const linkedEntity = linked && entities ? Object.values(entities).find((entity) => entity.acai === linked) : undefined
  const choose = (candidate: LinkCandidate) => {
    void onChange(concept.id, { acai: candidate.acai })
    setPicking(false)
    setQuery("")
  }

  const option = (candidate: LinkCandidate) => {
    const description = pick(candidate.entity.descriptions)
    return (
      <li key={candidate.id}>
        <button
          type="button"
          onClick={() => choose(candidate)}
          className="flex w-full flex-col items-start rounded px-2 py-1 text-start text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <bdi className="font-medium">{nameOf(candidate.entity) ?? candidate.acai}</bdi>
          {description && (
            <span lang={description.lang} dir="auto" className="line-clamp-1 text-muted-foreground">
              {description.text}
            </span>
          )}
          <code className="text-[10px] text-muted-foreground">{candidate.acai}</code>
        </button>
      </li>
    )
  }

  return (
    <section className="grid gap-2" data-testid="term-bible-link">
      <h3 className="text-xs font-medium">{t("terminology.bibleLink.heading")}</h3>
      <p className="text-xs text-muted-foreground">{t("terminology.bibleLink.hint")}</p>
      {linked ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span data-testid="term-bible-link-current">
            {t("terminology.bibleLink.linkedTo", { name: fmt.isolate(nameOf(linkedEntity) ?? linked) })}
          </span>
          <code className="text-[10px] text-muted-foreground">{linked}</code>
          {canEdit && !picking && (
            <>
              <Button type="button" size="xs" variant="outline" onClick={() => setPicking(true)}>
                {t("terminology.bibleLink.change")}
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => void onChange(concept.id, undefined)}>
                {t("terminology.bibleLink.unlink")}
              </Button>
            </>
          )}
        </div>
      ) : (
        !picking && (
          <Button type="button" size="xs" variant="outline" className="justify-self-start" onClick={() => setPicking(true)}>
            {t("terminology.bibleLink.link")}
          </Button>
        )
      )}
      {picking && (
        <div className="grid gap-2 rounded-md border p-2" data-testid="term-bible-link-picker">
          <div className="flex gap-2">
            {books && books.length > 0 && (
              <select
                aria-label={t("terminology.bibleLink.book")}
                value={book ?? ""}
                onChange={(e) => setBook(e.target.value)}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                {books.map((code) => (
                  <option key={code} value={code}>
                    {getBookName(code) ?? code}
                  </option>
                ))}
              </select>
            )}
            <Input
              aria-label={t("terminology.bibleLink.search")}
              placeholder={t("terminology.bibleLink.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
          {failed && (
            <p className="text-xs text-destructive">{t("terminology.bibleLink.loadFailed")}</p>
          )}
          {loading && (
            <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
          )}
          {entities && candidates.suggested.length > 0 && (
            <>
              <h4 className="text-[11px] text-muted-foreground">{t("terminology.bibleLink.suggested")}</h4>
              <ul data-testid="term-bible-link-suggested">{candidates.suggested.map(option)}</ul>
            </>
          )}
          {entities && candidates.others.length > 0 && (
            <ul className="max-h-60 overflow-y-auto" data-testid="term-bible-link-options">
              {candidates.others.map(option)}
            </ul>
          )}
          {((entities && candidates.suggested.length + candidates.others.length === 0) || books?.length === 0) && (
            <p className="text-xs text-muted-foreground">{t("terminology.bibleLink.empty")}</p>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="justify-self-start"
            onClick={() => {
              setPicking(false)
              setQuery("")
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </section>
  )
}
