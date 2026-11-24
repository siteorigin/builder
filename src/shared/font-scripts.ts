/**
 * The alphabets a font file covers, named the way a person would ask for them. Web fonts are often split into one
 * file per alphabet (a Latin file and a Cyrillic file of the same upright face), so this is what tells two
 * otherwise identical files apart.
 */
export interface FontScript {
  id: string;
  label: string;
  /** A few letters to show the file in, from this alphabet. */
  sample: string;
  /** Characters typical of the alphabet; a file covers it when it has most of them. */
  letters: string;
}

export const FONT_SCRIPTS: readonly FontScript[] = [
  { id: 'latin', label: 'Latin', sample: 'Aa Gg Rr', letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' },
  { id: 'latin-ext', label: 'Latin Extended', sample: 'Ąą Łł Žž', letters: 'ĀāĂăĄąĆćČčĎďĐđĒēĘęĚěĞğĪīĮįĶķĹĺĻļĽľŁłŃńŅņŇňŌōŐőŔŕŘřŚśŞşŠšŢţŤťŪūŮůŰűŲųŹźŻżŽž' },
  { id: 'vietnamese', label: 'Vietnamese', sample: 'Ặặ Ơơ Ưư', letters: 'ẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰự' },
  { id: 'greek', label: 'Greek', sample: 'Αα Ββ Γγ', letters: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω' },
  { id: 'cyrillic', label: 'Cyrillic', sample: 'Аа Бб Жж', letters: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя' },
  { id: 'cyrillic-ext', label: 'Cyrillic Extended', sample: 'Ғғ Ққ Әә', letters: 'ҒғҖҗҚқҢңҮүҲҳҶҷҺһӘәӨөӢӣӮӯӀҘҙҠҡҤҥҪҫӁӂӐӑӒӓӔӕӖӗӜӝӞӟӦӧӰӱӲӳӸӹ' },
  { id: 'armenian', label: 'Armenian', sample: 'Աա Բբ Գգ', letters: 'ԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖաբգդեզէըթժիլխծկհձղճմյնշոչպջռսվտրցւփքօֆ' },
  { id: 'georgian', label: 'Georgian', sample: 'ა ბ გ', letters: 'აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ' },
  { id: 'hebrew', label: 'Hebrew', sample: 'א ב ג', letters: 'אבגדהוזחטיכלמנסעפצקרשת' },
  { id: 'arabic', label: 'Arabic', sample: 'ا ب ت', letters: 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي' },
  { id: 'devanagari', label: 'Devanagari', sample: 'अ क ग', letters: 'अआइईउऊएऐओऔकखगघचछजझटठडढणतथदधनपफबभमयरलवशषसह' },
  { id: 'thai', label: 'Thai', sample: 'ก ข ค', letters: 'กขคฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ' },
  { id: 'japanese', label: 'Japanese', sample: 'あ ア 字', letters: 'あいうえおかきくけこさしすせそたちつてとなにぬねのアイウエオカキクケコサシスセソタチツテト' },
  { id: 'korean', label: 'Korean', sample: '가 나 다', letters: '가나다라마바사아자차카타파하고노도로모보소오조초코토포호' },
  { id: 'chinese', label: 'Chinese', sample: '中 文 字', letters: '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而' },
  { id: 'math', label: 'Math symbols', sample: '∑ ∫ ≠', letters: '∀∂∃∅∇∈∉∋∏∑∓√∝∞∠∧∨∩∪∫∴∼≅≈≠≡≤≥⊂⊃⊆⊇⊕⊗⊥' },
  { id: 'symbols', label: 'Symbols', sample: '← ■ ★', letters: '←→↔↕↖↗↘↙■□▲△▶▷▼▽◀◁◆◇○●★☆' }
];

/** The share of an alphabet's typical characters a file must have to count as covering it. */
const COVERED = 0.75;

/**
 * The alphabets a font covers, in FONT_SCRIPTS order, given whether it maps a code point to a glyph. Empty when it
 * covers none of them (an icon font, a file of punctuation).
 */
export function scriptsCovered(has: (codePoint: number) => boolean): string[] {
  return FONT_SCRIPTS.filter((s) => {
    const cps = [...s.letters].map((c) => c.codePointAt(0)!);
    return cps.filter(has).length >= cps.length * COVERED;
  }).map((s) => s.id);
}

export interface FontCoverage {
  /** FONT_SCRIPTS IDs, in that order. */
  scripts: string[];
  /** A few characters the file has, to show it in: its first alphabet's sample, or the first characters it maps. */
  sample: string;
}

/** What a font covers, given whether it maps a code point to a glyph. */
export function fontCoverageOf(has: (codePoint: number) => boolean): FontCoverage {
  const scripts = scriptsCovered(has);
  const first = FONT_SCRIPTS.find((s) => s.id === scripts[0]);
  if (first) return { scripts, sample: first.sample };
  // No alphabet: show what it does have (a file of capitals, figures or symbols), skipping controls and spaces.
  const chars: string[] = [];
  for (let cp = 0x21; cp <= 0xffff && chars.length < 8; cp++) if (!(cp >= 0x7f && cp <= 0xa0) && !(cp >= 0xd800 && cp <= 0xdfff) && has(cp)) chars.push(String.fromCodePoint(cp));
  return { scripts, sample: chars.join(' ') };
}

/** The alphabets' names, as a list ("Latin, Cyrillic"); unknown IDs are skipped. */
export function scriptLabels(ids: readonly string[] | undefined): string[] {
  return (ids ?? []).flatMap((id) => FONT_SCRIPTS.find((s) => s.id === id)?.label ?? []);
}
