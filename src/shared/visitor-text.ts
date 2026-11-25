import type { SiteDoc } from './types';
import { siteLanguage } from './languages';
import { clipText } from './not-found';

/**
 * The words a generated site says on its own, around the author's content: the skip link, the menu and submenu
 * buttons, the Light/Dark switch, landmark names, a contact form's progress, search results, the image viewer, a carousel's buttons and
 * count, and the video player. Each
 * comes in the language of the page it is on, from the author's own wording for that language when there is one,
 * then the built-in wording for the language, then English.
 */

export interface VisitorTextField {
  key: VisitorTextKey;
  /** What the field is called in Site styles. */
  label: string;
  /** Where visitors meet it. */
  hint: string;
  /** Names in braces the wording may use, filled in when it is shown ("{count}"). */
  fills?: string[];
}

export const VISITOR_TEXT_KEYS = [
  'skipLink',
  'menu',
  'mainNav',
  'submenu',
  'home',
  'themeToggle',
  'formSubmit',
  'formSending',
  'formSendingStatus',
  'formSent',
  'formFailed',
  'formNotConnected',
  'formDuplicateNames',
  'formNoChoices',
  'searchLandmark',
  'searchLabel',
  'searchButton',
  'searchEmpty',
  'searchSearching',
  'searchFailed',
  'searchNone',
  'searchAdvice',
  'searchOne',
  'searchMany',
  'searchLimited',
  'searchResults',
  'imageOpen',
  'imageDialog',
  'imageClose',
  'imagePrevious',
  'imageNext',
  'imageCount',
  'carouselLabel',
  'carouselPrevious',
  'carouselNext',
  'carouselOne',
  'carouselMany',
  'filterLabel',
  'filterAll',
  'filterOne',
  'filterMany',
  'videoPlay',
  'videoFrom',
  'videoLoads',
  'tableRegion',
  'redirect',
  'readingTime',
  'archiveNav',
  'archivePrevious',
  'archiveNext',
  'archivePage',
  'archivePageOf',
  'archiveCategory',
  'archiveEmpty'
] as const;

export type VisitorTextKey = (typeof VISITOR_TEXT_KEYS)[number];
export type VisitorText = Record<VisitorTextKey, string>;

/** The longest wording an author can set for one of them. */
export const VISITOR_TEXT_LIMIT = 300;

/** The fields as Site styles lists them, in groups. */
export const VISITOR_TEXT_GROUPS: Array<{ label: string; fields: VisitorTextField[] }> = [
  {
    label: 'Header and navigation',
    fields: [
      { key: 'skipLink', label: 'Skip link', hint: 'The first link keyboard users reach, which jumps past the header.' },
      { key: 'menu', label: 'Menu button', hint: 'The menu button on phones. Screen readers also say whether the menu is open.' },
      { key: 'mainNav', label: 'Main navigation', hint: 'The name screen readers give the header’s links.' },
      { key: 'submenu', label: 'Submenu button', hint: 'The button beside a header link that shows the links under it.', fills: ['link'] },
      { key: 'home', label: 'Home link', hint: 'The name of the logo’s link on a header without a site name, whose logo has no alternative text.' },
      { key: 'themeToggle', label: 'Light and dark switch', hint: 'The header’s button that switches between the light and dark colors, on a site whose visitors can switch (Site styles > Colors).' }
    ]
  },
  {
    label: 'Contact form',
    fields: [
      { key: 'formSubmit', label: 'Send button', hint: 'The send button of a form whose own label is empty.' },
      { key: 'formSending', label: 'Sending button', hint: 'The send button while a message is on its way.' },
      { key: 'formSendingStatus', label: 'Sending message', hint: 'Announced while a message is on its way.' },
      { key: 'formSent', label: 'Sent', hint: 'Announced once a message is sent, on a form without a message of its own.' },
      { key: 'formFailed', label: 'Not sent', hint: 'Announced when a message could not be sent, on a form without a message of its own.' },
      { key: 'formNotConnected', label: 'Not connected', hint: 'Shown on a form that has no form service yet.' },
      { key: 'formDuplicateNames', label: 'Fields share a name', hint: 'Shown on a form with two fields of the same name.' },
      { key: 'formNoChoices', label: 'Question without answers', hint: 'Shown on a form with a choice question that has no answers.' }
    ]
  },
  {
    label: 'Site search',
    fields: [
      { key: 'searchLandmark', label: 'Search area', hint: 'The name screen readers give a search box without a heading.' },
      { key: 'searchLabel', label: 'Search box', hint: 'The search box’s label when its own is empty.' },
      { key: 'searchButton', label: 'Search button', hint: 'The search button when its own label is empty.' },
      { key: 'searchEmpty', label: 'Empty search', hint: 'Shown when the visitor searches for nothing, on a search box without a message of its own.' },
      { key: 'searchSearching', label: 'Searching', hint: 'Announced while the search runs.' },
      { key: 'searchFailed', label: 'Search failed', hint: 'Shown when the search cannot load.' },
      { key: 'searchNone', label: 'No results', hint: 'Shown when nothing matches, before the advice.', fills: ['query'] },
      { key: 'searchAdvice', label: 'No-results advice', hint: 'Shown after it, on a search box without advice of its own.' },
      { key: 'searchOne', label: 'One result', hint: 'Shown when one page matches.', fills: ['query'] },
      { key: 'searchMany', label: 'Several results', hint: 'Shown when several pages match.', fills: ['count', 'query'] },
      { key: 'searchLimited', label: 'Too many results', hint: 'Shown when more pages match than the list shows.', fills: ['count', 'query', 'shown'] },
      { key: 'searchResults', label: 'Results list', hint: 'The name screen readers give the list of results.', fills: ['query'] }
    ]
  },
  {
    label: 'Image viewer',
    fields: [
      { key: 'imageOpen', label: 'Open image', hint: 'Read out on an image that opens full size.' },
      { key: 'imageDialog', label: 'Viewer', hint: 'The viewer’s name when the image has no caption or alternative text.' },
      { key: 'imageClose', label: 'Close', hint: 'The viewer’s close button.' },
      { key: 'imagePrevious', label: 'Previous image', hint: 'The viewer’s button for the image before.' },
      { key: 'imageNext', label: 'Next image', hint: 'The viewer’s button for the image after.' },
      { key: 'imageCount', label: 'Position', hint: 'Where the image is among a gallery’s images.', fills: ['index', 'count'] }
    ]
  },
  {
    label: 'Carousel',
    fields: [
      { key: 'carouselLabel', label: 'Slides', hint: 'The name screen readers give a carousel’s slides when it has no heading or name of its own.' },
      { key: 'carouselPrevious', label: 'Previous slide', hint: 'The carousel’s button for the slide before.' },
      { key: 'carouselNext', label: 'Next slide', hint: 'The carousel’s button for the slide after.' },
      { key: 'carouselOne', label: 'One slide showing', hint: 'Beside the buttons, and announced, when one slide shows.', fills: ['index', 'count'] },
      { key: 'carouselMany', label: 'Several slides showing', hint: 'Beside the buttons, and announced, when several slides show at once.', fills: ['first', 'last', 'count'] }
    ]
  },
  {
    label: 'Category filters',
    fields: [
      { key: 'filterLabel', label: 'Filters', hint: 'The name screen readers give a list’s row of category buttons.' },
      { key: 'filterAll', label: 'All', hint: 'The button that shows every item again.' },
      { key: 'filterOne', label: 'One item showing', hint: 'Announced when a category leaves one item showing.' },
      { key: 'filterMany', label: 'Several items showing', hint: 'Announced when a category leaves several items showing.', fills: ['count'] }
    ]
  },
  {
    label: 'Video, tables and moved pages',
    fields: [
      { key: 'videoPlay', label: 'Play video', hint: 'The video’s play button.' },
      { key: 'videoFrom', label: 'Untitled video', hint: 'The name of a video without a title.', fills: ['host'] },
      { key: 'videoLoads', label: 'Player note', hint: 'Under the play button, saying where the player comes from.', fills: ['host'] },
      { key: 'tableRegion', label: 'Table', hint: 'The name screen readers give a table without a caption or heading.' },
      { key: 'redirect', label: 'Moved page', hint: 'The link on an old address, for browsers that do not go on by themselves.' }
    ]
  },
  {
    label: 'Posts',
    fields: [
      { key: 'readingTime', label: 'Reading time', hint: 'In a post’s layout, how long its text takes to read.', fills: ['count'] },
      { key: 'archiveNav', label: 'Page links', hint: 'The name screen readers give the links between the pages of a blog’s index or category archive.' },
      { key: 'archivePrevious', label: 'Previous page', hint: 'The link to the page of newer posts before it.' },
      { key: 'archiveNext', label: 'Next page', hint: 'The link to the page of older posts after it.' },
      { key: 'archivePage', label: 'Page link', hint: 'Read out on the link to one numbered page.', fills: ['page'] },
      { key: 'archivePageOf', label: 'Page number', hint: 'Under the heading of every page after the first.', fills: ['page', 'count'] },
      { key: 'archiveCategory', label: 'Category', hint: 'Above the category’s name on its archive page.' },
      { key: 'archiveEmpty', label: 'Nothing published', hint: 'On a blog’s index before anything is published.' }
    ]
  }
];

const EN: VisitorText = {
  skipLink: 'Skip to content',
  menu: 'Menu',
  mainNav: 'Main',
  submenu: '{link} submenu',
  home: 'Home',
  themeToggle: 'Dark mode',
  formSubmit: 'Send message',
  formSending: 'Sending…',
  formSendingStatus: 'Sending your message…',
  formSent: 'Thank you. Your message has been sent.',
  formFailed: 'Sorry, your message could not be sent. Please try again or contact us directly.',
  formNotConnected: 'This form is not connected to a form service yet, so it cannot be sent.',
  formDuplicateNames: 'Two fields of this form have the same name, so it cannot be sent.',
  formNoChoices: 'A question in this form has no answers to choose from yet, so it cannot be sent.',
  searchLandmark: 'Site search',
  searchLabel: 'Search for',
  searchButton: 'Search',
  searchEmpty: 'Type a word or phrase to search for.',
  searchSearching: 'Searching…',
  searchFailed: 'The search could not load. Reload the page and try again.',
  searchNone: 'No pages match “{query}”.',
  searchAdvice: 'Try fewer or different words.',
  searchOne: '1 page matches “{query}”.',
  searchMany: '{count} pages match “{query}”.',
  searchLimited: '{count} pages match “{query}”. The first {shown} are shown; add words to narrow the search.',
  searchResults: 'Pages matching {query}',
  imageOpen: 'View full image',
  imageDialog: 'Full image',
  imageClose: 'Close',
  imagePrevious: 'Previous image',
  imageNext: 'Next image',
  imageCount: '{index} of {count}',
  carouselLabel: 'Slides',
  carouselPrevious: 'Previous',
  carouselNext: 'Next',
  carouselOne: 'Slide {index} of {count}',
  carouselMany: 'Slides {first}–{last} of {count}',
  filterLabel: 'Filter by category',
  filterAll: 'All',
  filterOne: '1 item showing',
  filterMany: '{count} items showing',
  videoPlay: 'Play video',
  videoFrom: 'Video from {host}',
  videoLoads: 'Loads the player from {host}',
  tableRegion: 'Table',
  redirect: 'This page has moved. Continue to its new address.',
  readingTime: '{count} min read',
  archiveNav: 'Pages',
  archivePrevious: 'Previous page',
  archiveNext: 'Next page',
  archivePage: 'Page {page}',
  archivePageOf: 'Page {page} of {count}',
  archiveCategory: 'Category',
  archiveEmpty: 'Nothing has been published here yet.'
};

const AR: VisitorText = {
  skipLink: 'انتقل إلى المحتوى',
  menu: 'القائمة',
  mainNav: 'القائمة الرئيسية',
  submenu: 'قائمة {link} الفرعية',
  home: 'الصفحة الرئيسية',
  themeToggle: 'الوضع الداكن',
  formSubmit: 'إرسال الرسالة',
  formSending: 'جارٍ الإرسال…',
  formSendingStatus: 'جارٍ إرسال رسالتك…',
  formSent: 'شكرًا لك. تم إرسال رسالتك.',
  formFailed: 'عذرًا، تعذّر إرسال رسالتك. يُرجى المحاولة مرة أخرى أو التواصل معنا مباشرة.',
  formNotConnected: 'هذا النموذج غير متصل بخدمة نماذج بعد، لذا لا يمكن إرساله.',
  formDuplicateNames: 'في هذا النموذج حقلان بالاسم نفسه، لذا لا يمكن إرساله.',
  formNoChoices: 'في هذا النموذج سؤال ليست له إجابات للاختيار منها بعد، لذا لا يمكن إرساله.',
  searchLandmark: 'البحث في الموقع',
  searchLabel: 'ابحث عن',
  searchButton: 'بحث',
  searchEmpty: 'اكتب كلمة أو عبارة للبحث عنها.',
  searchSearching: 'جارٍ البحث…',
  searchFailed: 'تعذّر تحميل البحث. أعد تحميل الصفحة وحاول مرة أخرى.',
  searchNone: 'لا توجد صفحات تطابق «{query}».',
  searchAdvice: 'جرّب كلمات أقل أو مختلفة.',
  searchOne: 'صفحة واحدة تطابق «{query}».',
  searchMany: 'عدد الصفحات التي تطابق «{query}»: {count}.',
  searchLimited: 'عدد الصفحات التي تطابق «{query}»: {count}. تظهر أول {shown} منها؛ أضف كلمات لتضييق البحث.',
  searchResults: 'نتائج البحث عن {query}',
  imageOpen: 'عرض الصورة كاملة',
  imageDialog: 'الصورة كاملة',
  imageClose: 'إغلاق',
  imagePrevious: 'الصورة السابقة',
  imageNext: 'الصورة التالية',
  imageCount: '{index} من {count}',
  carouselLabel: 'الشرائح',
  carouselPrevious: 'السابق',
  carouselNext: 'التالي',
  carouselOne: 'الشريحة {index} من {count}',
  carouselMany: 'الشرائح {first}–{last} من {count}',
  filterLabel: 'التصفية حسب التصنيف',
  filterAll: 'الكل',
  filterOne: 'يظهر عنصر واحد',
  filterMany: 'عدد العناصر الظاهرة: {count}',
  videoPlay: 'تشغيل الفيديو',
  videoFrom: 'فيديو من {host}',
  videoLoads: 'يُحمَّل المشغّل من {host}',
  tableRegion: 'جدول',
  redirect: 'نُقلت هذه الصفحة. تابع إلى عنوانها الجديد.',
  readingTime: 'وقت القراءة: {count} دقيقة',
  archiveNav: 'الصفحات',
  archivePrevious: 'الصفحة السابقة',
  archiveNext: 'الصفحة التالية',
  archivePage: 'الصفحة {page}',
  archivePageOf: 'الصفحة {page} من {count}',
  archiveCategory: 'التصنيف',
  archiveEmpty: 'لم يُنشر شيء هنا بعد.'
};

const HE: VisitorText = {
  skipLink: 'דילוג לתוכן',
  menu: 'תפריט',
  mainNav: 'תפריט ראשי',
  submenu: 'תפריט המשנה של {link}',
  home: 'דף הבית',
  themeToggle: 'מצב כהה',
  formSubmit: 'שליחת ההודעה',
  formSending: 'בשליחה…',
  formSendingStatus: 'ההודעה שלך נשלחת…',
  formSent: 'תודה. ההודעה שלך נשלחה.',
  formFailed: 'מצטערים, לא ניתן היה לשלוח את ההודעה. אפשר לנסות שוב או לפנות אלינו ישירות.',
  formNotConnected: 'הטופס הזה עדיין לא מחובר לשירות טפסים, ולכן אי אפשר לשלוח אותו.',
  formDuplicateNames: 'לשני שדות בטופס הזה יש אותו שם, ולכן אי אפשר לשלוח אותו.',
  formNoChoices: 'לשאלה בטופס הזה עדיין אין תשובות לבחירה, ולכן אי אפשר לשלוח אותו.',
  searchLandmark: 'חיפוש באתר',
  searchLabel: 'חיפוש',
  searchButton: 'חיפוש',
  searchEmpty: 'יש להקליד מילה או ביטוי לחיפוש.',
  searchSearching: 'החיפוש מתבצע…',
  searchFailed: 'לא ניתן היה לטעון את החיפוש. יש לטעון מחדש את הדף ולנסות שוב.',
  searchNone: 'אין דפים שתואמים ל"{query}".',
  searchAdvice: 'כדאי לנסות פחות מילים או מילים אחרות.',
  searchOne: 'דף אחד תואם ל"{query}".',
  searchMany: 'דפים שתואמים ל"{query}": {count}.',
  searchLimited: 'דפים שתואמים ל"{query}": {count}. מוצגים {shown} הראשונים; אפשר להוסיף מילים כדי לצמצם את החיפוש.',
  searchResults: 'תוצאות החיפוש עבור {query}',
  imageOpen: 'הצגת התמונה המלאה',
  imageDialog: 'תמונה מלאה',
  imageClose: 'סגירה',
  imagePrevious: 'התמונה הקודמת',
  imageNext: 'התמונה הבאה',
  imageCount: '{index} מתוך {count}',
  carouselLabel: 'שקופיות',
  carouselPrevious: 'הקודם',
  carouselNext: 'הבא',
  carouselOne: 'שקופית {index} מתוך {count}',
  carouselMany: 'שקופיות {first}–{last} מתוך {count}',
  filterLabel: 'סינון לפי קטגוריה',
  filterAll: 'הכול',
  filterOne: 'מוצג פריט אחד',
  filterMany: 'פריטים מוצגים: {count}',
  videoPlay: 'הפעלת הסרטון',
  videoFrom: 'סרטון מ-{host}',
  videoLoads: 'הנגן נטען מ-{host}',
  tableRegion: 'טבלה',
  redirect: 'הדף הזה הועבר. אפשר להמשיך לכתובת החדשה שלו.',
  readingTime: '{count} דק׳ קריאה',
  archiveNav: 'עמודים',
  archivePrevious: 'העמוד הקודם',
  archiveNext: 'העמוד הבא',
  archivePage: 'עמוד {page}',
  archivePageOf: 'עמוד {page} מתוך {count}',
  archiveCategory: 'קטגוריה',
  archiveEmpty: 'עדיין לא פורסם כאן דבר.'
};

/** Built-in wording by primary language subtag. Hebrew is also known by its old code. */
const BUILT_IN: Record<string, VisitorText> = { en: EN, ar: AR, he: HE, iw: HE };

/** The languages with built-in wording, as Site styles names them. */
export const VISITOR_TEXT_LANGUAGES = ['en', 'ar', 'he'];

/** A language code as visitor text is kept under it: lower case, so "ar-EG" and "ar-eg" share their wording. */
export const visitorTextLanguage = (code: string): string => code.toLowerCase();

/** Characters that show nothing: spaces, and the zero-width and other invisible formatting characters. */
const INVISIBLE = /^[\s\p{Cf}ᅟᅠ⠀ㅤﾠ]*$/u;

/** The author's wording as it is used: trimmed and within the limit, or empty when it shows nothing. */
export function ownVisitorText(value: unknown): string {
  const text = typeof value === 'string' ? clipText(value.trim(), VISITOR_TEXT_LIMIT).trim() : '';
  return INVISIBLE.test(text) ? '' : text;
}

/** The built-in wording for a language: its own when there is some, English otherwise. */
export function builtInVisitorText(language: string): VisitorText {
  const primary = visitorTextLanguage(language).split('-')[0];
  return Object.hasOwn(BUILT_IN, primary) ? BUILT_IN[primary] : EN;
}

/** The author's wording for one language, read defensively: site.json may have been edited by hand. */
function ownFor(site: Pick<SiteDoc, 'visitorText'>, language: string): Partial<Record<VisitorTextKey, unknown>> {
  const all = site.visitorText;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return {};
  // Kept under the lower-case code. Keys written by hand in other cases count too, after it and in a fixed order:
  // each piece comes from the first of them that says something.
  const keys = Object.keys(all)
    .filter((k) => visitorTextLanguage(k) === language)
    .sort((a, b) => (a === language ? -1 : b === language ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const out: Partial<Record<VisitorTextKey, unknown>> = {};
  for (const k of keys) {
    const own = all[k];
    if (!own || typeof own !== 'object' || Array.isArray(own)) continue;
    for (const piece of VISITOR_TEXT_KEYS) if (Object.hasOwn(own, piece) && !ownVisitorText(out[piece]) && ownVisitorText(own[piece])) out[piece] = own[piece];
  }
  return out;
}

/** The author's wording for one language as the site uses it: each piece that says something, within the limit. */
export function ownVisitorTextFor(site: Pick<SiteDoc, 'visitorText'>, language: string): Partial<Record<VisitorTextKey, string>> {
  const own = ownFor(site, visitorTextLanguage(language));
  const out: Partial<Record<VisitorTextKey, string>> = {};
  for (const key of VISITOR_TEXT_KEYS) {
    const text = ownVisitorText(own[key]);
    if (text) out[key] = text;
  }
  return out;
}

/**
 * Everything a page in `language` says on its own. Each piece is the author's wording for that exact language, then
 * for its primary language ("ar" for "ar-EG"), then the built-in wording.
 */
export function visitorTextFor(site: Pick<SiteDoc, 'visitorText'>, language: string): VisitorText {
  const code = visitorTextLanguage(language);
  const primary = code.split('-')[0];
  const exact = ownFor(site, code);
  const general = primary === code ? {} : ownFor(site, primary);
  const builtIn = builtInVisitorText(code);
  const out = {} as VisitorText;
  for (const key of VISITOR_TEXT_KEYS) out[key] = ownVisitorText(exact[key]) || ownVisitorText(general[key]) || builtIn[key];
  return out;
}

/** The wording a page in the site's language uses. */
export const siteVisitorText = (site: Pick<SiteDoc, 'language' | 'visitorText'>): VisitorText => visitorTextFor(site, siteLanguage(site));

/** Whether a value names a piece of visitor text. */
export const isVisitorTextKey = (key: unknown): key is VisitorTextKey => typeof key === 'string' && (VISITOR_TEXT_KEYS as readonly string[]).includes(key);
