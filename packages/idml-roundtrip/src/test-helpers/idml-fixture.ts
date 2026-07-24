import JSZip from "jszip"

const IDML_MIMETYPE = "application/vnd.adobe.indesign-idml-package"
const FIXTURE_DATE = new Date("2024-01-01T00:00:00.000Z")

export const mixedStoryXml = `<?xml version="1.0" encoding="UTF-8"?>\r
<idPkg:Story xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">\r
  <Story Self="u1">\r
    <ParagraphStyleRange Self="p1" AppliedParagraphStyle="ParagraphStyle/Body">\r
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content> Bold </Content><Content>and</Content></CharacterStyleRange>\r
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Italic"><Content> italic é漢字</Content><CrossReferenceSource Self="xref1"/><TextVariableInstance Self="var1"/><Mystery Self="m1"/></CharacterStyleRange>\r
      <Table><Cell Name="0:0"><ParagraphStyleRange Self="p2"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Table"><Content> cell </Content></CharacterStyleRange></ParagraphStyleRange></Cell></Table>\r
      <Footnote><ParagraphStyleRange Self="p3"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Footnote"><Content>foot&amp;note</Content></CharacterStyleRange></ParagraphStyleRange></Footnote>\r
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><TextFrame ParentStory="u3"/><Br/></CharacterStyleRange>\r
    </ParagraphStyleRange>\r
  </Story>\r
</idPkg:Story>`

export const anchoredStoryXml = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging"><Story Self="u3"><ParagraphStyleRange Self="p4"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>anchored</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`

export const remainingStoryXml = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging"><Story Self="u9"><ParagraphStyleRange Self="p9"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>remaining</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`

export const designmapXml = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:DesignMap xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging"><idPkg:Story src="Stories/Story_u1.xml"/><idPkg:Story src="Stories/Story_u3.xml"/></idPkg:DesignMap>`

export const textVariablesXml = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:TextVariables xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging"><TextVariable Self="TextVariable/Custom" VariableType="CustomTextType"><Contents>literal variable</Contents></TextVariable><TextVariable Self="TextVariable/Page" VariableType="PageNumberType"><Contents>1</Contents></TextVariable></idPkg:TextVariables>`

export const baseFixtureMembers: Readonly<Record<string, string | Uint8Array>> = {
  "designmap.xml": designmapXml,
  "Stories/Story_u1.xml": mixedStoryXml,
  "Stories/Story_u3.xml": anchoredStoryXml,
  "Stories/Story_u9.xml": remainingStoryXml,
  "Resources/TextVariables.xml": textVariablesXml,
  "Resources/Styles.xml": `<?xml version="1.0" encoding="UTF-8"?><idPkg:Styles xmlns:idPkg="urn:test"><Root Self="styles"/></idPkg:Styles>`,
  "Spreads/Spread_u1.xml": `<?xml version="1.0" encoding="UTF-8"?><idPkg:Spread xmlns:idPkg="urn:test"><Spread Self="spread"><TextFrame ParentStory="u1"/></Spread></idPkg:Spread>`,
  "Links/logo.bin": Uint8Array.from([0, 1, 2, 3, 255]),
}

export async function makeIdml(
  overrides: Readonly<Record<string, string | Uint8Array | null>> = {},
): Promise<Uint8Array> {
  const members = new Map<string, string | Uint8Array>()
  for (const [path, value] of Object.entries(baseFixtureMembers)) members.set(path, value)
  for (const [path, value] of Object.entries(overrides)) {
    if (value === null) members.delete(path)
    else members.set(path, value)
  }

  const zip = new JSZip()
  zip.file("mimetype", IDML_MIMETYPE, {
    compression: "STORE",
    createFolders: false,
    date: FIXTURE_DATE,
  })
  for (const [path, value] of members) {
    zip.file(path, value, {
      binary: value instanceof Uint8Array,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      createFolders: false,
      date: FIXTURE_DATE,
    })
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
    streamFiles: false,
  })
}
