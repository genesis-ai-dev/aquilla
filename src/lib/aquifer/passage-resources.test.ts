import { describe, expect, it } from "vitest"
import {
  buildMapMosaic,
  coordsToTilePoint,
  DEFAULT_MAP_ZOOM,
  formatCoordinates,
  osmPermalink,
  OSM_TILE_SIZE,
  parseEntityCoordinates,
  parseEntityImage,
  parseEntitySummary,
  parsePassageEntities,
  passagePathFromRef,
} from "./passage-resources"

// Abridged from the live response for /en/passages/MAT/2/1/ — the shape the
// parsers actually have to survive: the entity list is the second-to-last
// section, and a further "## Translation Questions" section follows it.
const PASSAGE_MARKDOWN = `# Matthew 2:1
Translation notes and study guidance from 8 scholarly sources.
## Overview
This verse introduces a new event in the story.
## Study Notes
### Matthew 2:1
- Bethlehem was King David's hometown.
## Entities in this Passage
- [Bethlehem (of Judah)](/en/places/bethlehem/) (place)
- [Herod](/en/people/herod/) (person)
- [Jerusalem](/en/places/jerusalem/) (place)
- [Jesus](/en/people/jesus-2/) (person)
- [Judea](/en/places/judea/) (place)
## Translation Questions
**Where was Jesus born?** Jesus was born in Bethlehem of Judea.
Content last updated: 2026-08-06`

// Abridged from /en/places/bethlehem/.
const PLACE_MARKDOWN = `# Bethlehem (of Judah)
City
A town in the territory of Judah, southwest of Jerusalem, where Jesus was born; ancestral town of King David.
**Region of:** [Territory of Judah](/en/places/territoryofjudah/) **Coordinates:** [31.7054°, 35.2103°](https://www.openstreetmap.org/?mlat=31.70536129&mlon=35.2102663#map=10/31.70536129/35.2102663)
**Also called:** [Ephrath](/en/places/ephrath/)
## Key Bible References
- [John 7:42](/en/passages/JHN/7/42/)`

const PAGE_URL = "https://bibletranslation.org/en/places/bethlehem/"

describe("passagePathFromRef", () => {
  it("maps a verse ref to its passage page", () => {
    expect(passagePathFromRef("RUT 1:8")).toBe("/en/passages/RUT/1/8/")
    expect(passagePathFromRef("1SA 16:1")).toBe("/en/passages/1SA/16/1/")
  })

  it("upper-cases the book so a lower-case ref still resolves", () => {
    expect(passagePathFromRef("mat 2:1")).toBe("/en/passages/MAT/2/1/")
  })

  it("returns null for refs with no verse — there is no page for those", () => {
    expect(passagePathFromRef("GEN 1")).toBeNull() // chapter-scoped
    expect(passagePathFromRef("GEN 1:s:1")).toBeNull() // a heading, not a verse
    expect(passagePathFromRef("")).toBeNull()
    expect(passagePathFromRef("not a ref")).toBeNull()
  })
})

describe("parsePassageEntities", () => {
  it("reads every entity with its kind", () => {
    expect(parsePassageEntities(PASSAGE_MARKDOWN)).toEqual([
      { title: "Bethlehem (of Judah)", path: "/en/places/bethlehem/", kind: "place" },
      { title: "Herod", path: "/en/people/herod/", kind: "person" },
      { title: "Jerusalem", path: "/en/places/jerusalem/", kind: "place" },
      { title: "Jesus", path: "/en/people/jesus-2/", kind: "person" },
      { title: "Judea", path: "/en/places/judea/", kind: "place" },
    ])
  })

  it("stops at the next section rather than swallowing later links", () => {
    const withTrailingLinks = `${PASSAGE_MARKDOWN}
## See Also
- [Nazareth](/en/places/nazareth/) (place)`
    const paths = parsePassageEntities(withTrailingLinks).map((e) => e.path)
    expect(paths).not.toContain("/en/places/nazareth/")
  })

  it("falls back to the URL segment when a line omits its (kind)", () => {
    const md = `## Entities in this Passage
- [Jerusalem](/en/places/jerusalem/)`
    expect(parsePassageEntities(md)).toEqual([
      { title: "Jerusalem", path: "/en/places/jerusalem/", kind: "place" },
    ])
  })

  it("de-duplicates entities listed twice", () => {
    const md = `## Entities in this Passage
- [Jerusalem](/en/places/jerusalem/) (place)
- [Jerusalem](/en/places/jerusalem/) (place)`
    expect(parsePassageEntities(md)).toHaveLength(1)
  })

  it("returns [] when the page has no entity section (truncated or plain verse)", () => {
    expect(parsePassageEntities("# Psalm 119:1\n## Overview\nA verse.")).toEqual([])
    expect(parsePassageEntities("")).toEqual([])
  })
})

describe("parseEntityCoordinates", () => {
  it("prefers the full-precision OpenStreetMap link over the rounded label", () => {
    expect(parseEntityCoordinates(PLACE_MARKDOWN)).toEqual({
      lat: 31.70536129,
      lon: 35.2102663,
    })
  })

  it("falls back to the printed label when there is no link", () => {
    expect(parseEntityCoordinates("**Coordinates:** [31.7054°, 35.2103°]")).toEqual({
      lat: 31.7054,
      lon: 35.2103,
    })
  })

  it("reads southern/western hemispheres as negative numbers", () => {
    expect(
      parseEntityCoordinates("[link](https://www.openstreetmap.org/?mlat=-1.5&mlon=-78.25#map=6)"),
    ).toEqual({ lat: -1.5, lon: -78.25 })
  })

  it("returns null for a page with no location", () => {
    expect(parseEntityCoordinates(PASSAGE_MARKDOWN)).toBeNull()
  })

  it("rejects out-of-range numbers rather than placing a bogus marker", () => {
    expect(
      parseEntityCoordinates("[x](https://www.openstreetmap.org/?mlat=931.7&mlon=35.2)"),
    ).toBeNull()
    expect(
      parseEntityCoordinates("[x](https://www.openstreetmap.org/?mlat=31.7&mlon=935.2)"),
    ).toBeNull()
  })
})

describe("parseEntityImage", () => {
  it("absolutizes a site-relative image against the page URL", () => {
    expect(parseEntityImage("![A lion](/media/lion.jpg)", PAGE_URL)).toEqual({
      url: "https://bibletranslation.org/media/lion.jpg",
      alt: "A lion",
    })
  })

  it("keeps an already-absolute image", () => {
    expect(parseEntityImage("![](https://cdn.example/x.png)", PAGE_URL)).toEqual({
      url: "https://cdn.example/x.png",
      alt: "",
    })
  })

  it("drops non-http(s) sources from upstream content", () => {
    expect(parseEntityImage("![x](javascript:alert(1))", PAGE_URL)).toBeNull()
    expect(parseEntityImage("![x](data:image/png;base64,AAAA)", PAGE_URL)).toBeNull()
  })

  it("returns null when the page has no image — the corpus today", () => {
    expect(parseEntityImage(PLACE_MARKDOWN, PAGE_URL)).toBeNull()
  })
})

describe("parseEntitySummary", () => {
  it("takes the gloss, skipping the title, the type word and metadata rows", () => {
    expect(parseEntitySummary(PLACE_MARKDOWN)).toBe(
      "A town in the territory of Judah, southwest of Jerusalem, where Jesus was born; ancestral town of King David.",
    )
  })

  it("returns null when the page opens straight into a section", () => {
    expect(parseEntitySummary("# Title\n## Key Bible References\n- [x](/y/)")).toBeNull()
  })
})

describe("map mosaic", () => {
  it("places the equator/prime-meridian origin at the centre of the pyramid", () => {
    const point = coordsToTilePoint({ lat: 0, lon: 0 }, 1)
    expect(point.x).toBeCloseTo(1, 6)
    expect(point.y).toBeCloseTo(1, 6)
  })

  it("covers the whole viewport and centres the marker", () => {
    const { tiles, marker } = buildMapMosaic({ lat: 31.705, lon: 35.21 }, 272, 180)
    expect(marker).toEqual({ left: 136, top: 90 })
    expect(tiles.length).toBeGreaterThan(0)

    // Every viewport pixel is covered by some tile.
    for (const [px, py] of [
      [0, 0],
      [271, 0],
      [0, 179],
      [271, 179],
      [136, 90],
    ]) {
      const covering = tiles.filter(
        (t) =>
          px >= t.left && px < t.left + OSM_TILE_SIZE && py >= t.top && py < t.top + OSM_TILE_SIZE,
      )
      expect(covering).toHaveLength(1)
    }
  })

  it("requests tiles from the OSM raster layer at the asked-for zoom", () => {
    const { tiles } = buildMapMosaic({ lat: 31.705, lon: 35.21 }, 272, 180, 5)
    for (const tile of tiles) {
      expect(tile.url).toMatch(/tile\.openstreetmap\.org\/5\/\d+\/\d+\.png$/)
    }
  })

  it("drops tiles past the poles instead of requesting 404s", () => {
    const { tiles } = buildMapMosaic({ lat: 84.9, lon: 0 }, 272, 180, 2)
    for (const tile of tiles) {
      const [, y] = /\/2\/(\d+)\/(\d+)\.png$/.exec(tile.url)!.slice(1)
      expect(Number(y)).toBeLessThan(4)
      expect(Number(y)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe("osmPermalink / formatCoordinates", () => {
  it("links to the marked point at the panel's zoom", () => {
    expect(osmPermalink({ lat: 31.705, lon: 35.21 })).toBe(
      `https://www.openstreetmap.org/?mlat=31.705&mlon=35.21#map=${DEFAULT_MAP_ZOOM}/31.705/35.21`,
    )
  })

  it("labels hemispheres rather than printing a minus sign", () => {
    expect(formatCoordinates({ lat: 31.7054, lon: 35.2103 })).toBe("31.705°N, 35.210°E")
    expect(formatCoordinates({ lat: -1.5, lon: -78.25 })).toBe("1.500°S, 78.250°W")
  })
})
