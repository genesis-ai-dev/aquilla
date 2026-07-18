// src/pages/Homepage/udhr-article1.data.ts
//
// Universal Declaration of Human Rights, Article 1 — a secular, public-domain
// analog to the eBible corpus used on the BT landing page. UDHR is
// professionally translated into 500+ languages and is itself marketed by the
// UN as "the most translated document in the world," making it a credible
// multilingual proof point with no religious content.
//
// Text sourced from established published UDHR translations; verify the
// less-common-language entries (Amharic, Georgian) against an authoritative
// source before launch — same caveat the Come-and-See stats carry elsewhere
// on this page.

export interface SampleEntry {
  code: string
  name: string
  en: string
  text: string
  dir: "ltr" | "rtl"
  script: string
  domain: string
}

const EN = "All human beings are born free and equal in dignity and rights. They are endowed with reason and conscience and should act towards one another in a spirit of brotherhood."

export const UDHR_ARTICLE1: SampleEntry[] = [
  { code: "eng", name: "English", en: EN, text: EN, dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "spa", name: "Español", en: EN, text: "Todos los seres humanos nacen libres e iguales en dignidad y derechos y, dotados como están de razón y conciencia, deben comportarse fraternalmente los unos con los otros.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "fra", name: "Français", en: EN, text: "Tous les êtres humains naissent libres et égaux en dignité et en droits. Ils sont doués de raison et de conscience et doivent agir les uns envers les autres dans un esprit de fraternité.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "arb", name: "العربية", en: EN, text: "يولد جميع الناس أحرارًا متساوين في الكرامة والحقوق، وقد وهبوا عقلاً وضميرًا وعليهم أن يعامل بعضهم بعضاً بروح الإخاء.", dir: "rtl", script: "Arabic", domain: "udhr" },
  { code: "cmn", name: "中文", en: EN, text: "人人生而自由,在尊严和权利上一律平等。他们赋有理性和良心,并应以兄弟关系的精神相对待。", dir: "ltr", script: "Han", domain: "udhr" },
  { code: "rus", name: "Русский", en: EN, text: "Все люди рождаются свободными и равными в своем достоинстве и правах. Они наделены разумом и совестью и должны поступать в отношении друг друга в духе братства.", dir: "ltr", script: "Cyrillic", domain: "udhr" },
  { code: "hin", name: "हिन्दी", en: EN, text: "सभी मनुष्यों को गौरव और अधिकारों के मामले में जन्मजात स्वतन्त्रता और समानता प्राप्त है। उन्हें बुद्धि और अन्तरात्मा की देन प्राप्त है और परस्पर उन्हें भाईचारे के भाव से बर्ताव करना चाहिए।", dir: "ltr", script: "Devanagari", domain: "udhr" },
  { code: "ben", name: "বাংলা", en: EN, text: "সমস্ত মানুষ স্বাধীনভাবে সমান মর্যাদা এবং অধিকার নিয়ে জন্মগ্রহণ করে। তাঁদের বিবেক এবং বুদ্ধি আছে; সুতরাং সকলেরই একে অপরের প্রতি ভ্রাতৃত্বসুলভ মনোভাব নিয়ে আচরণ করা উচিত।", dir: "ltr", script: "Bengali", domain: "udhr" },
  { code: "por", name: "Português", en: EN, text: "Todos os seres humanos nascem livres e iguais em dignidade e em direitos. Dotados de razão e de consciência, devem agir uns para com os outros em espírito de fraternidade.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "deu", name: "Deutsch", en: EN, text: "Alle Menschen sind frei und gleich an Würde und Rechten geboren. Sie sind mit Vernunft und Gewissen begabt und sollen einander im Geist der Brüderlichkeit begegnen.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "jpn", name: "日本語", en: EN, text: "すべての人間は、生まれながらにして自由であり、かつ、尊厳と権利とについて平等である。人間は、理性と良心とを授けられており、互いに同胞の精神をもって行動しなければならない。", dir: "ltr", script: "Han / Kana", domain: "udhr" },
  { code: "kor", name: "한국어", en: EN, text: "모든 인간은 태어날 때부터 자유로우며 그 존엄과 권리에 있어 동등하다. 인간은 천부적으로 이성과 양심을 부여받았으며 서로 형제애의 정신으로 행동하여야 한다.", dir: "ltr", script: "Hangul", domain: "udhr" },
  { code: "swh", name: "Kiswahili", en: EN, text: "Watu wote wamezaliwa huru, hadhi na haki zao ni sawa. Wote wamejaliwa akili na dhamiri, hivyo yapasa kutendeana kindugu.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "amh", name: "አማርኛ", en: EN, text: "ሁሉም ሰዎች ነጻ ሆነው የተወለዱ ናቸው፣ በክብርና በመብትም እኩል ናቸው። የተፈጥሮ የማስተዋልና ሕሊና ስላላቸው አንዳቸው ለሌላው በወንድማማችነት መንፈስ መተያየት ይገባቸዋል።", dir: "ltr", script: "Geʻez", domain: "udhr" },
  { code: "vie", name: "Tiếng Việt", en: EN, text: "Mọi người sinh ra đều được tự do và bình đẳng về nhân phẩm và các quyền. Mọi người đều được phú bẩm về lý trí và lương tâm và cần phải đối xử với nhau trong tình bằng hữu.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "tha", name: "ไทย", en: EN, text: "มนุษย์ทั้งปวงเกิดมามีอิสระและเสมอภาคกันในเกียรติศักดิ์และสิทธิ ต่างมีเหตุผลและมโนธรรม และควรปฏิบัติต่อกันด้วยจิตวิญญาณแห่งภราดรภาพ", dir: "ltr", script: "Thai", domain: "udhr" },
  { code: "heb", name: "עברית", en: EN, text: "כל בני האדם נולדו בני חורין ושווים בערכם ובזכויותיהם. כולם חוננו בתבונה ובמצפון, לפיכך חובה עליהם לנהוג איש ברעהו ברוח של אחווה.", dir: "rtl", script: "Hebrew", domain: "udhr" },
  { code: "tur", name: "Türkçe", en: EN, text: "Bütün insanlar hür, haysiyet ve haklar bakımından eşit doğarlar. Akıl ve vicdana sahiptirler ve birbirlerine karşı kardeşlik zihniyeti ile hareket etmelidirler.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "fas", name: "فارسی", en: EN, text: "تمام افراد بشر آزاد به دنیا می‌آیند و از لحاظ حیثیت و کرامت و حقوق با هم برابرند. همه دارای عقل و وجدان می‌باشند و باید نسبت به یکدیگر با روح برادری رفتار کنند.", dir: "rtl", script: "Arabic", domain: "udhr" },
  { code: "urd", name: "اردو", en: EN, text: "تمام انسان آزاد اور حقوق و عزت کے اعتبار سے برابر پیدا ہوئے ہیں۔ انہیں ضمیر اور عقل ودیعت ہوئی ہے اس لئے انہیں ایک دوسرے کے ساتھ بھائی چارے کا سلوک کرنا چاہئے۔", dir: "rtl", script: "Arabic", domain: "udhr" },
  { code: "ind", name: "Bahasa Indonesia", en: EN, text: "Semua orang dilahirkan merdeka dan mempunyai martabat dan hak-hak yang sama. Mereka dikaruniai akal dan hati nurani dan hendaknya bergaul satu sama lain dalam semangat persaudaraan.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "pol", name: "Polski", en: EN, text: "Wszyscy ludzie rodzą się wolni i równi pod względem swej godności i swych praw. Są oni obdarzeni rozumem i sumieniem i powinni postępować wobec innych w duchu braterstwa.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "ell", name: "Ελληνικά", en: EN, text: "Όλοι οι άνθρωποι γεννιούνται ελεύθεροι και ίσοι στην αξιοπρέπεια και τα δικαιώματα. Είναι προικισμένοι με λογική και συνείδηση, και οφείλουν να συμπεριφέρονται μεταξύ τους με πνεύμα αδελφοσύνης.", dir: "ltr", script: "Greek", domain: "udhr" },
  { code: "kat", name: "ქართული", en: EN, text: "ყველა ადამიანი დაბადებით თავისუფალია და თანასწორი თავისი ღირსებითა და უფლებებით. მათ მინიჭებული აქვთ გონება და სინდისი და ერთმანეთის მიმართ უნდა იქცეოდნენ ძმობის სულისკვეთებით.", dir: "ltr", script: "Georgian", domain: "udhr" },
]
