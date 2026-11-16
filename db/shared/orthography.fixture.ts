// The real Run A output behind AQU-2628, kept as a test fixture.
//
// `GEN1_OLD_SPELLING` is what the model actually returned on 16 Nov 2026 for
// Genesis 1 with the full 2026 alphabet rule in its prompt — 31 of 31 verses
// in the old spelling, 175 old forms, not one new letter. `GEN1_NEW_SPELLING`
// is the same 31 after the converter. Because the "before" side is genuine
// model output rather than a reverse-generated copy, the round-trip test in
// ./orthography.test.ts is a real test and not a tautology.

export interface Gen1Verse {
  ref: string
  text: string
}

export const GEN1_OLD_SPELLING: readonly Gen1Verse[] = [
  { ref: "GEN 1:1", text: "Boshida Xudo osmon va yerni yaratdi." },
  { ref: "GEN 1:2", text: "Yer shaklsiz va bo‘sh edi. Qorong‘ilik tubning yuzasida edi, Xudoning Ruhi esa suvlar yuzasida parvoz qilardi." },
  { ref: "GEN 1:3", text: "Xudo: «Yorug‘lik bo‘lsin», dedi va yorug‘lik paydo bo‘ldi." },
  { ref: "GEN 1:4", text: "Xudo yorug‘likni ko‘rdi va uning yaxshi ekanini ko‘rdi. Xudo yorug‘likni qorong‘ilikdan ajratdi." },
  { ref: "GEN 1:5", text: "Xudo yorug‘likni «kun» deb atadi, qorong‘ilikni esa «tun» deb atadi. Kech bo‘ldi va tong bo‘ldi — birinchi kun." },
  { ref: "GEN 1:6", text: "Xudo dedi: «Suvlar o‘rtasida osmon kengligi bo‘lsin va u suvlarni suvlarning biridan ajratsin.»" },
  { ref: "GEN 1:7", text: "Xudo osmon kengligini yaratdi va osmon kengligi ostidagi suvlarni osmon kengligi ustidagi suvlardan ajratdi. Shunday bo‘ldi." },
  { ref: "GEN 1:8", text: "Xudo osmon gumbazini “osmon” deb atadi. Kech bo‘ldi va tong otdi — ikkinchi kun." },
  { ref: "GEN 1:9", text: "Xudo dedi: «Osmon ostidagi suvlar bir joyga to‘plansin, quruq yer ko‘rinsin», va shunday bo‘ldi." },
  { ref: "GEN 1:10", text: "Xudo quruq yerni “yer” deb atadi, suvlarning to‘plangan joyini esa “dengizlar” deb atadi. Xudo bu yaxshi ekanini ko‘rdi." },
  { ref: "GEN 1:11", text: "Xudo dedi: «Yer o‘t-o‘lanlar, urug‘ beradigan o‘simliklar va o‘z turiga ko‘ra meva beradigan, urug‘i mevasining ichida bo‘lgan mevali daraxtlarni chiqarsin», va shunday bo‘ldi." },
  { ref: "GEN 1:12", text: "Yer o‘t-o‘lanlarni, o‘z turiga ko‘ra urug‘ beradigan o‘simliklarni va urug‘i mevasining ichida bo‘lgan, o‘z turiga ko‘ra meva beradigan daraxtlarni chiqardi. Xudo bu yaxshi ekanini ko‘rdi." },
  { ref: "GEN 1:13", text: "Kech bo‘ldi va tong otdi — uchinchi kun." },
  { ref: "GEN 1:14", text: "Xudo dedi: «Osmon gumbazida kunduzni tundan ajratish uchun chiroqlar bo‘lsin; ular fasllar, kunlar va yillarni belgilaydigan belgilar bo‘lsin;" },
  { ref: "GEN 1:15", text: "ular yerga yorug‘lik berish uchun osmon gumbazida chiroqlar bo‘lsin»; shunday bo‘ldi." },
  { ref: "GEN 1:16", text: "Xudo ikkita buyuk chiroqni yaratdi: kattaroq chiroq kunduzni, kichikroq chiroq esa tunni boshqarishi uchun. U yulduzlarni ham yaratdi." },
  { ref: "GEN 1:17", text: "Xudo ularni yerga yorug‘lik berish uchun osmon gumbaziga joylashtirdi," },
  { ref: "GEN 1:18", text: "kunduzni va tunni boshqarish, yorug‘likni qorong‘ilikdan ajratish uchun. Xudo buni yaxshi deb ko‘rdi." },
  { ref: "GEN 1:19", text: "Kech bo‘ldi, tong otdi — to‘rtinchi kun." },
  { ref: "GEN 1:20", text: "Xudo dedi: «Suvlar tirik mavjudotlar bilan to‘lib-toshsin, qushlar esa yer uzra, osmonning ochiq kengligida uchsin»." },
  { ref: "GEN 1:21", text: "Xudo katta dengiz maxluqlarini, suvlar to‘lib-toshgan har xil harakatlanuvchi tirik mavjudotlarni o‘z turiga ko‘ra, shuningdek, har xil qanotli qushni o‘z turiga ko‘ra yaratdi. Xudo buni yaxshi deb ko‘rdi." },
  { ref: "GEN 1:22", text: "Xudo ularga duo qilib dedi: «Serpusht bo‘linglar, ko‘payinglar, dengizlardagi suvlarni to‘ldiringlar, qushlar esa yer yuzida ko‘paysin»." },
  { ref: "GEN 1:23", text: "Kech bo‘ldi va tong otdi — beshinchi kun." },
  { ref: "GEN 1:24", text: "Xudo dedi: «Yer o‘z turiga ko‘ra tirik mavjudotlarni, chorvani, sudralib yuruvchilarni va yer hayvonlarini o‘z turiga ko‘ra chiqarsin». Va shunday bo‘ldi." },
  { ref: "GEN 1:25", text: "Xudo yer hayvonlarini o‘z turiga ko‘ra, chorvani o‘z turiga ko‘ra va yerda sudraladigan har bir narsani o‘z turiga ko‘ra yaratdi. Xudo buni yaxshi deb ko‘rdi." },
  { ref: "GEN 1:26", text: "Xudo dedi: «Odamni bizning suratimizga, o‘xshashligimizga ko‘ra yaratamiz. U dengizdagi baliqlar, osmondagi qushlar, chorva, butun yer va yerda sudraladigan har bir narsa ustidan hukmronlik qilsin»." },
  { ref: "GEN 1:27", text: "Xudo odamni o‘z suratida yaratdi. Uni Xudoning suratida yaratdi; ularni erkak va ayol qilib yaratdi." },
  { ref: "GEN 1:28", text: "Xudo ularni duo qildi. Xudo ularga dedi: «Serfarzand bo‘linglar, ko‘payinglar, yerni to‘ldiringlar va uni bo‘ysundiringlar. Dengizdagi baliqlar, osmondagi qushlar va yerda harakatlanuvchi har bir tirik mavjudot ustidan hukmronlik qilinglar.»" },
  { ref: "GEN 1:29", text: "Xudo dedi: «Mana, butun yer yuzida urug‘ beradigan har bir o‘simlikni va urug‘ beradigan meva beradigan har bir daraxtni sizlarga berdim. Ular sizlarga oziq bo‘ladi." },
  { ref: "GEN 1:30", text: "Yer yuzidagi har bir hayvonga, osmondagi har bir qushga va yerda sudralib yuradigan, ichida hayot bo‘lgan har bir mavjudotga oziq uchun har qanday yashil o‘simlikni berdim»; shunday bo‘ldi." },
  { ref: "GEN 1:31", text: "Xudo yaratgan hamma narsani ko‘rdi va mana, u juda yaxshi edi. Kech bo‘ldi, tong bo‘ldi — oltinchi kun." },
]

export const GEN1_NEW_SPELLING: readonly Gen1Verse[] = [
  { ref: "GEN 1:1", text: "Boşida Xudo osmon va yerni yaratdi." },
  { ref: "GEN 1:2", text: "Yer şaklsiz va böş edi. Qoronğilik tubning yuzasida edi, Xudoning Ruhi esa suvlar yuzasida parvoz qilardi." },
  { ref: "GEN 1:3", text: "Xudo: «Yoruğlik bölsin», dedi va yoruğlik paydo böldi." },
  { ref: "GEN 1:4", text: "Xudo yoruğlikni kördi va uning yaxşi ekanini kördi. Xudo yoruğlikni qoronğilikdan ajratdi." },
  { ref: "GEN 1:5", text: "Xudo yoruğlikni «kun» deb atadi, qoronğilikni esa «tun» deb atadi. Keç böldi va tong böldi — birinçi kun." },
  { ref: "GEN 1:6", text: "Xudo dedi: «Suvlar örtasida osmon kengligi bölsin va u suvlarni suvlarning biridan ajratsin.»" },
  { ref: "GEN 1:7", text: "Xudo osmon kengligini yaratdi va osmon kengligi ostidagi suvlarni osmon kengligi ustidagi suvlardan ajratdi. Şunday böldi." },
  { ref: "GEN 1:8", text: "Xudo osmon gumbazini “osmon” deb atadi. Keç böldi va tong otdi — ikkinçi kun." },
  { ref: "GEN 1:9", text: "Xudo dedi: «Osmon ostidagi suvlar bir joyga töplansin, quruq yer körinsin», va şunday böldi." },
  { ref: "GEN 1:10", text: "Xudo quruq yerni “yer” deb atadi, suvlarning töplangan joyini esa “dengizlar” deb atadi. Xudo bu yaxşi ekanini kördi." },
  { ref: "GEN 1:11", text: "Xudo dedi: «Yer öt-ölanlar, uruğ beradigan ösimliklar va öz turiga köra meva beradigan, uruği mevasining içida bölgan mevali daraxtlarni çiqarsin», va şunday böldi." },
  { ref: "GEN 1:12", text: "Yer öt-ölanlarni, öz turiga köra uruğ beradigan ösimliklarni va uruği mevasining içida bölgan, öz turiga köra meva beradigan daraxtlarni çiqardi. Xudo bu yaxşi ekanini kördi." },
  { ref: "GEN 1:13", text: "Keç böldi va tong otdi — uçinçi kun." },
  { ref: "GEN 1:14", text: "Xudo dedi: «Osmon gumbazida kunduzni tundan ajratiş uçun çiroqlar bölsin; ular fasllar, kunlar va yillarni belgilaydigan belgilar bölsin;" },
  { ref: "GEN 1:15", text: "ular yerga yoruğlik beriş uçun osmon gumbazida çiroqlar bölsin»; şunday böldi." },
  { ref: "GEN 1:16", text: "Xudo ikkita buyuk çiroqni yaratdi: kattaroq çiroq kunduzni, kiçikroq çiroq esa tunni boşqarişi uçun. U yulduzlarni ham yaratdi." },
  { ref: "GEN 1:17", text: "Xudo ularni yerga yoruğlik beriş uçun osmon gumbaziga joylaştirdi," },
  { ref: "GEN 1:18", text: "kunduzni va tunni boşqariş, yoruğlikni qoronğilikdan ajratiş uçun. Xudo buni yaxşi deb kördi." },
  { ref: "GEN 1:19", text: "Keç böldi, tong otdi — törtinçi kun." },
  { ref: "GEN 1:20", text: "Xudo dedi: «Suvlar tirik mavjudotlar bilan tölib-toşsin, quşlar esa yer uzra, osmonning oçiq kengligida uçsin»." },
  { ref: "GEN 1:21", text: "Xudo katta dengiz maxluqlarini, suvlar tölib-toşgan har xil harakatlanuvçi tirik mavjudotlarni öz turiga köra, şuningdek, har xil qanotli quşni öz turiga köra yaratdi. Xudo buni yaxşi deb kördi." },
  { ref: "GEN 1:22", text: "Xudo ularga duo qilib dedi: «Serpuşt bölinglar, köpayinglar, dengizlardagi suvlarni töldiringlar, quşlar esa yer yuzida köpaysin»." },
  { ref: "GEN 1:23", text: "Keç böldi va tong otdi — beşinçi kun." },
  { ref: "GEN 1:24", text: "Xudo dedi: «Yer öz turiga köra tirik mavjudotlarni, çorvani, sudralib yuruvçilarni va yer hayvonlarini öz turiga köra çiqarsin». Va şunday böldi." },
  { ref: "GEN 1:25", text: "Xudo yer hayvonlarini öz turiga köra, çorvani öz turiga köra va yerda sudraladigan har bir narsani öz turiga köra yaratdi. Xudo buni yaxşi deb kördi." },
  { ref: "GEN 1:26", text: "Xudo dedi: «Odamni bizning suratimizga, öxşaşligimizga köra yaratamiz. U dengizdagi baliqlar, osmondagi quşlar, çorva, butun yer va yerda sudraladigan har bir narsa ustidan hukmronlik qilsin»." },
  { ref: "GEN 1:27", text: "Xudo odamni öz suratida yaratdi. Uni Xudoning suratida yaratdi; ularni erkak va ayol qilib yaratdi." },
  { ref: "GEN 1:28", text: "Xudo ularni duo qildi. Xudo ularga dedi: «Serfarzand bölinglar, köpayinglar, yerni töldiringlar va uni böysundiringlar. Dengizdagi baliqlar, osmondagi quşlar va yerda harakatlanuvçi har bir tirik mavjudot ustidan hukmronlik qilinglar.»" },
  { ref: "GEN 1:29", text: "Xudo dedi: «Mana, butun yer yuzida uruğ beradigan har bir ösimlikni va uruğ beradigan meva beradigan har bir daraxtni sizlarga berdim. Ular sizlarga oziq böladi." },
  { ref: "GEN 1:30", text: "Yer yuzidagi har bir hayvonga, osmondagi har bir quşga va yerda sudralib yuradigan, içida hayot bölgan har bir mavjudotga oziq uçun har qanday yaşil ösimlikni berdim»; şunday böldi." },
  { ref: "GEN 1:31", text: "Xudo yaratgan hamma narsani kördi va mana, u juda yaxşi edi. Keç böldi, tong böldi — oltinçi kun." },
]

/** The Northern Uzbek 2026 alphabet, as a project would store it. */
export const UZBEK_2026_RULES = [
  ["sh", "ş"],
  ["ch", "ç"],
  ["oʻ", "ö"],
  ["gʻ", "ğ"],
] as const

/** Words where `s` and `h` are separate sounds — the seed list from the ticket. */
export const UZBEK_2026_SEED_EXCEPTIONS = ["Isʼhoq", "asʼhob", "masʼhab", "masʼhur"] as const
