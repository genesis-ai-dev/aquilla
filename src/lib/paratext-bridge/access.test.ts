import { describe, it, expect } from "vitest"
import { parseProjectUserAccess, editDenial } from "./access"

const XML = `﻿<?xml version="1.0" encoding="utf-8"?>
<ProjectUserAccess PeerSharing="true">
  <User UserName="Ryder Wishart" FirstUser="true" UnregisteredUser="false">
    <Role>Administrator</Role>
    <AllBooks>true</AllBooks>
    <Books />
  </User>
  <User UserName="Ana &amp; Co" FirstUser="false" UnregisteredUser="false">
    <Role>Translator</Role>
    <AllBooks>false</AllBooks>
    <Books>
      <Book Id="MAT" Chapters="1-5,7" />
      <Book Id="MRK" />
    </Books>
  </User>
  <User UserName="Chris" FirstUser="false" UnregisteredUser="false">
    <Role>Consultant</Role>
    <AllBooks>true</AllBooks>
  </User>
</ProjectUserAccess>`

describe("ProjectUserAccess", () => {
  const access = parseProjectUserAccess(XML)

  it("parses users, roles, book grants and chapter ranges", () => {
    expect(access.users.map((u) => u.userName)).toEqual(["Ryder Wishart", "Ana & Co", "Chris"])
    expect(access.users[1].books).toEqual([
      { book: "MAT", chapters: [{ from: 1, to: 5 }, { from: 7, to: 7 }] },
      { book: "MRK", chapters: [] },
    ])
  })

  it("administrators edit everything; unknown users nothing", () => {
    expect(editDenial(access, "Ryder Wishart", "REV", 22)).toBeNull()
    expect(editDenial(access, "Nobody", "MAT", 1)).toBe("unknown-user")
  })

  it("translators are limited to granted books and chapters", () => {
    expect(editDenial(access, "Ana & Co", "MAT", 3)).toBeNull()
    expect(editDenial(access, "Ana & Co", "MAT", 7)).toBeNull()
    expect(editDenial(access, "Ana & Co", "MAT", 6)).toBe("chapter-not-granted")
    expect(editDenial(access, "Ana & Co", "MRK", 16)).toBeNull()
    expect(editDenial(access, "Ana & Co", "LUK", 1)).toBe("book-not-granted")
  })

  it("consultants and observers never edit text, whatever AllBooks says", () => {
    expect(editDenial(access, "Chris", "MAT", 1)).toBe("read-only-role")
  })
})
