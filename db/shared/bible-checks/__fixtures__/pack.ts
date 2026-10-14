// Trimmed Bible Knowledge Pack v1 data for the Bible data check tests (AQU-1688).
//
// Copied unchanged from the pack's voices and structure layers (pack 1.0.0),
// trimmed to JHN 4:1–15, MAT 5:17–28 and MAT 14:8. Only those verses' runs, and
// the speeches they touch, are kept; each speech keeps its real first and last word.
//
// License: the Bible Knowledge Pack (bibletranslation.org) is CC BY-SA 4.0. The
// voices and structure layers are built from OpenText context-annotation
// (CC BY-SA 4.0), Clear speaker-quotations (CC BY 4.0) and Macula Greek (CC BY 4.0).

export const JHN4_VOICES = {
  book: "JHN",
  narrator: {kind: "narrator"},
  speeches: [
    {id: "sp:n43004007012-n43004007014", from: "n43004007012", to: "n43004007014", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n43004007008", speaker: "person:Jesus.2", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], addressee: "local:JHN:n43004007002", addresseeConf: 0.8, addresseeSources: ["macula-a2"], type: "Dialogue", delivery: "requesting", fcbh: "Jesus"},
    {id: "sp:n43004009008-n43004009018", from: "n43004009008", to: "n43004009018", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n43004009001", speaker: "local:JHN:n43004007002", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], addressee: "person:Jesus.2", addresseeConf: 0.8, addresseeSources: ["macula-a2"], type: "Dialogue", fcbh: "woman, Samaritan"},
    {id: "sp:n43004010006-n43004010030", from: "n43004010006", to: "n43004010030", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n43004010004", speaker: "person:Jesus.2", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], addressee: "local:JHN:n43004007002", addresseeConf: 0.8, addresseeSources: ["macula-a2"], type: "Dialogue", fcbh: "Jesus"},
    {id: "sp:n43004010018-n43004010020", from: "n43004010018", to: "n43004010020", depth: 3, level: 2, parent: "sp:n43004010006-n43004010030", selfProjected: false, projector: "n43004010016", speaker: "person:Jesus.2", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:JHN:n43004007002", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n43004011005-n43004012026", from: "n43004011005", to: "n43004012026", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n43004011001", speaker: "local:JHN:n43004007002", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], addressee: "person:Jesus.2", addresseeConf: 0.8, addresseeSources: ["macula-a2"], type: "Dialogue", fcbh: "woman, Samaritan"},
    {id: "sp:n43004013006-n43004014032", from: "n43004013006", to: "n43004014032", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n43004013004", speaker: "person:Jesus.2", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], addressee: "local:JHN:n43004007002", addresseeConf: 0.8, addresseeSources: ["macula-a2"], type: "Dialogue", fcbh: "Jesus"},
    {id: "sp:n43004015006-n43004015018", from: "n43004015006", to: "n43004015018", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n43004015001", speaker: "local:JHN:n43004007002", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], type: "Dialogue", fcbh: "woman, Samaritan"},
  ],
  verses: {
    "JHN 4:1": [{speech: "narrator", from: "n43004001001", to: "n43004001018", opens: false, closes: false}],
    "JHN 4:2": [{speech: "narrator", from: "n43004002001", to: "n43004002009", opens: false, closes: false}],
    "JHN 4:3": [{speech: "narrator", from: "n43004003001", to: "n43004003009", opens: false, closes: false}],
    "JHN 4:4": [{speech: "narrator", from: "n43004004001", to: "n43004004007", opens: false, closes: false}],
    "JHN 4:5": [{speech: "narrator", from: "n43004005001", to: "n43004005019", opens: false, closes: false}],
    "JHN 4:6": [{speech: "narrator", from: "n43004006001", to: "n43004006022", opens: false, closes: false}],
    "JHN 4:7": [{speech: "narrator", from: "n43004007001", to: "n43004007011", opens: false, closes: false}, {speech: "sp:n43004007012-n43004007014", from: "n43004007012", to: "n43004007014", opens: true, closes: true}],
    "JHN 4:8": [{speech: "narrator", from: "n43004008001", to: "n43004008011", opens: false, closes: false}],
    "JHN 4:9": [{speech: "narrator", from: "n43004009001", to: "n43004009007", opens: false, closes: false}, {speech: "sp:n43004009008-n43004009018", from: "n43004009008", to: "n43004009018", opens: true, closes: true}, {speech: "narrator", from: "n43004009019", to: "n43004009023", opens: false, closes: false}],
    "JHN 4:10": [{speech: "narrator", from: "n43004010001", to: "n43004010005", opens: false, closes: false}, {speech: "sp:n43004010006-n43004010030", from: "n43004010006", to: "n43004010017", opens: true, closes: false}, {speech: "sp:n43004010018-n43004010020", from: "n43004010018", to: "n43004010020", opens: true, closes: true}, {speech: "sp:n43004010006-n43004010030", from: "n43004010021", to: "n43004010030", opens: false, closes: true}],
    "JHN 4:11": [{speech: "narrator", from: "n43004011001", to: "n43004011004", opens: false, closes: false}, {speech: "sp:n43004011005-n43004012026", from: "n43004011005", to: "n43004011020", opens: true, closes: false}],
    "JHN 4:12": [{speech: "sp:n43004011005-n43004012026", from: "n43004012001", to: "n43004012026", opens: false, closes: true}],
    "JHN 4:13": [{speech: "narrator", from: "n43004013001", to: "n43004013005", opens: false, closes: false}, {speech: "sp:n43004013006-n43004014032", from: "n43004013006", to: "n43004013014", opens: true, closes: false}],
    "JHN 4:14": [{speech: "sp:n43004013006-n43004014032", from: "n43004014001", to: "n43004014032", opens: false, closes: true}],
    "JHN 4:15": [{speech: "narrator", from: "n43004015001", to: "n43004015005", opens: false, closes: false}, {speech: "sp:n43004015006-n43004015018", from: "n43004015006", to: "n43004015018", opens: true, closes: true}],
  },
}

export const JHN4_STRUCTURE = {
  book: "JHN",
  verses: {
    "JHN 4:1": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "JHN 4:2": {question: false, imperative: false, numerals: [], negators: ["n43004002004"], vocatives: []},
    "JHN 4:3": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "JHN 4:4": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "JHN 4:5": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "JHN 4:6": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "JHN 4:7": {question: false, imperative: true, numerals: [], negators: [], vocatives: []},
    "JHN 4:8": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "JHN 4:9": {question: true, imperative: false, numerals: [], negators: ["n43004009019"], vocatives: []},
    "JHN 4:10": {question: false, imperative: true, numerals: [], negators: [], vocatives: []},
    "JHN 4:11": {question: true, imperative: false, numerals: [], negators: ["n43004011006"], vocatives: ["n43004011005"]},
    "JHN 4:12": {question: true, imperative: false, numerals: [], negators: ["n43004012001"], vocatives: []},
    "JHN 4:13": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "JHN 4:14": {question: false, imperative: false, numerals: [], negators: ["n43004014012", "n43004014013"], vocatives: []},
    "JHN 4:15": {question: false, imperative: true, numerals: [], negators: ["n43004015013", "n43004015015"], vocatives: ["n43004015006"]},
  },
}

export const MAT_VOICES = {
  book: "MAT",
  narrator: {kind: "narrator"},
  speeches: [
    {id: "sp:n40005003001-n40007027025", from: "n40005003001", to: "n40007027025", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n40005002008", speaker: "person:Jesus.2", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], addressee: "local:MAT:n40005001015", addresseeConf: 0.6, addresseeSources: ["macula-2p"], type: "Implicit", delivery: "preaching", fcbh: "Jesus"},
    {id: "sp:n40005018005-n40005018027", from: "n40005018005", to: "n40005018027", depth: 3, level: 1, parent: "sp:n40005003001-n40007027025", selfProjected: true, projector: "n40005018003", speaker: "person:Jesus.2", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:MAT:n40005001015", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n40005020005-n40005020023", from: "n40005020005", to: "n40005020023", depth: 3, level: 1, parent: "sp:n40005003001-n40007027025", selfProjected: true, projector: "n40005020001", speaker: "person:Jesus.2", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:MAT:n40005001015", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n40005021006-n40005021015", from: "n40005021006", to: "n40005021015", depth: 3, level: 2, parent: "sp:n40005003001-n40007027025", selfProjected: false, projector: "n40005021003", speaker: "grp:MAT:n40005021003", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:MAT:n40005021005", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n40005022006-n40005022039", from: "n40005022006", to: "n40005022039", depth: 3, level: 1, parent: "sp:n40005003001-n40007027025", selfProjected: true, projector: "n40005022003", speaker: "person:Jesus.2", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:MAT:n40005001015", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n40005022023-n40005022023", from: "n40005022023", to: "n40005022023", depth: 4, level: 2, parent: "sp:n40005022006-n40005022039", selfProjected: false, projector: "n40005022019", speaker: "local:MAT:n40005019001", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:MAT:n40005022021", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n40005022032-n40005022032", from: "n40005022032", to: "n40005022032", depth: 4, level: 2, parent: "sp:n40005022006-n40005022039", selfProjected: false, projector: "n40005022031", speaker: "local:MAT:n40005019001", speakerConf: 0.75, speakerSources: ["macula"]},
    {id: "sp:n40005026004-n40005026013", from: "n40005026004", to: "n40005026013", depth: 3, level: 1, parent: "sp:n40005003001-n40007027025", selfProjected: true, projector: "n40005026002", speaker: "person:Jesus.2", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:MAT:n40005001015", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n40005027004-n40005027005", from: "n40005027004", to: "n40005027005", depth: 3, level: 2, parent: "sp:n40005003001-n40007027025", selfProjected: false, projector: "n40005027003", speaker: "local:MAT:n40005027005", speakerConf: 0.75, speakerSources: ["macula"]},
    {id: "sp:n40005028006-n40005028020", from: "n40005028006", to: "n40005028020", depth: 3, level: 1, parent: "sp:n40005003001-n40007027025", selfProjected: true, projector: "n40005028003", speaker: "person:Jesus.2", speakerConf: 0.75, speakerSources: ["macula"], addressee: "local:MAT:n40005001015", addresseeConf: 0.8, addresseeSources: ["macula-a2"]},
    {id: "sp:n40014008008-n40014008018", from: "n40014008008", to: "n40014008018", depth: 2, level: 1, parent: null, selfProjected: false, projector: "n40014008003", speaker: "local:MAT:n40014006008", speakerConf: 0.97, speakerSources: ["fcbh", "macula"], type: "Normal", fcbh: "Herodias' daughter"},
  ],
  verses: {
    "MAT 5:17": [{speech: "sp:n40005003001-n40007027025", from: "n40005017001", to: "n40005017015", opens: false, closes: false}],
    "MAT 5:18": [{speech: "sp:n40005003001-n40007027025", from: "n40005018001", to: "n40005018004", opens: false, closes: false}, {speech: "sp:n40005018005-n40005018027", from: "n40005018005", to: "n40005018027", opens: true, closes: true}],
    "MAT 5:19": [{speech: "sp:n40005003001-n40007027025", from: "n40005019001", to: "n40005019036", opens: false, closes: false}],
    "MAT 5:20": [{speech: "sp:n40005003001-n40007027025", from: "n40005020001", to: "n40005020004", opens: false, closes: false}, {speech: "sp:n40005020005-n40005020023", from: "n40005020005", to: "n40005020023", opens: true, closes: true}],
    "MAT 5:21": [{speech: "sp:n40005003001-n40007027025", from: "n40005021001", to: "n40005021005", opens: false, closes: false}, {speech: "sp:n40005021006-n40005021015", from: "n40005021006", to: "n40005021015", opens: true, closes: true}],
    "MAT 5:22": [{speech: "sp:n40005003001-n40007027025", from: "n40005022001", to: "n40005022005", opens: false, closes: false}, {speech: "sp:n40005022006-n40005022039", from: "n40005022006", to: "n40005022022", opens: true, closes: false}, {speech: "sp:n40005022023-n40005022023", from: "n40005022023", to: "n40005022023", opens: true, closes: true}, {speech: "sp:n40005022006-n40005022039", from: "n40005022024", to: "n40005022031", opens: false, closes: false}, {speech: "sp:n40005022032-n40005022032", from: "n40005022032", to: "n40005022032", opens: true, closes: true}, {speech: "sp:n40005022006-n40005022039", from: "n40005022033", to: "n40005022039", opens: false, closes: true}],
    "MAT 5:23": [{speech: "sp:n40005003001-n40007027025", from: "n40005023001", to: "n40005023019", opens: false, closes: false}],
    "MAT 5:24": [{speech: "sp:n40005003001-n40007027025", from: "n40005024001", to: "n40005024022", opens: false, closes: false}],
    "MAT 5:25": [{speech: "sp:n40005003001-n40007027025", from: "n40005025001", to: "n40005025030", opens: false, closes: false}],
    "MAT 5:26": [{speech: "sp:n40005003001-n40007027025", from: "n40005026001", to: "n40005026003", opens: false, closes: false}, {speech: "sp:n40005026004-n40005026013", from: "n40005026004", to: "n40005026013", opens: true, closes: true}],
    "MAT 5:27": [{speech: "sp:n40005003001-n40007027025", from: "n40005027001", to: "n40005027003", opens: false, closes: false}, {speech: "sp:n40005027004-n40005027005", from: "n40005027004", to: "n40005027005", opens: true, closes: true}],
    "MAT 5:28": [{speech: "sp:n40005003001-n40007027025", from: "n40005028001", to: "n40005028005", opens: false, closes: false}, {speech: "sp:n40005028006-n40005028020", from: "n40005028006", to: "n40005028020", opens: true, closes: true}],
    "MAT 14:8": [{speech: "narrator", from: "n40014008001", to: "n40014008007", opens: false, closes: false}, {speech: "sp:n40014008008-n40014008018", from: "n40014008008", to: "n40014008009", opens: true, closes: false}, {speech: "narrator", from: "n40014008010", to: "n40014008010", opens: false, closes: false}, {speech: "sp:n40014008008-n40014008018", from: "n40014008011", to: "n40014008018", opens: false, closes: true}],
  },
}

export const MAT_STRUCTURE = {
  book: "MAT",
  verses: {
    "MAT 5:17": {question: false, imperative: false, numerals: [], negators: ["n40005017001", "n40005017011"], vocatives: []},
    "MAT 5:18": {question: false, imperative: false, numerals: [], negators: ["n40005018018", "n40005018019"], vocatives: []},
    "MAT 5:19": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "MAT 5:20": {question: false, imperative: false, numerals: [], negators: ["n40005020006", "n40005020016", "n40005020017"], vocatives: []},
    "MAT 5:21": {question: false, imperative: false, numerals: [], negators: ["n40005021006"], vocatives: []},
    "MAT 5:22": {question: false, imperative: false, numerals: [], negators: [], vocatives: ["n40005022023", "n40005022032"]},
    "MAT 5:23": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "MAT 5:24": {question: false, imperative: true, numerals: [], negators: [], vocatives: []},
    "MAT 5:25": {question: false, imperative: true, numerals: [], negators: [], vocatives: []},
    "MAT 5:26": {question: false, imperative: false, numerals: [], negators: ["n40005026004", "n40005026005"], vocatives: []},
    "MAT 5:27": {question: false, imperative: false, numerals: [], negators: ["n40005027004"], vocatives: []},
    "MAT 5:28": {question: false, imperative: false, numerals: [], negators: [], vocatives: []},
    "MAT 14:8": {question: false, imperative: true, numerals: [], negators: [], vocatives: []},
  },
}
