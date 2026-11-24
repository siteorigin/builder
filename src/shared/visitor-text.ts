import type { SiteDoc } from './types';
import { siteLanguage } from './languages';
import { clipText } from './not-found';

/**
 * The words a generated site says on its own, around the author's content: the skip link, the menu button, landmark
 * names, a contact form's progress, search results, the image viewer and the video player. Each comes in the
 * language of the page it is on, from the author's own wording for that language when there is one, then the
 * built-in wording for the language, then English.
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
  'menuOpen',
  'menuClose',
  'mainNav',
  'home',
  'formSending',
  'formSendingStatus',
  'formNotConnected',
  'formDuplicateNames',
  'formNoChoices',
  'searchLandmark',
  'searchLabel',
  'searchButton',
  'searchSearching',
  'searchFailed',
  'searchNone',
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
  'videoPlay',
  'videoFrom',
  'videoLoads',
  'tableRegion',
  'redirect'
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
      { key: 'menuOpen', label: 'Open menu', hint: 'The menu button on phones, while the menu is closed.' },
      { key: 'menuClose', label: 'Close menu', hint: 'The menu button on phones, while the menu is open.' },
      { key: 'mainNav', label: 'Main navigation', hint: 'The name screen readers give the header’s links.' },
      { key: 'home', label: 'Home link', hint: 'The name of the logo’s link when the site name is hidden and the logo has no alternative text.' }
    ]
  },
  {
    label: 'Contact form',
    fields: [
      { key: 'formSending', label: 'Sending button', hint: 'The send button while a message is on its way.' },
      { key: 'formSendingStatus', label: 'Sending message', hint: 'Announced while a message is on its way.' },
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
      { key: 'searchSearching', label: 'Searching', hint: 'Announced while the search runs.' },
      { key: 'searchFailed', label: 'Search failed', hint: 'Shown when the search cannot load.' },
      { key: 'searchNone', label: 'No results', hint: 'Shown before the search box’s own advice when nothing matches.', fills: ['query'] },
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
    label: 'Video, tables and moved pages',
    fields: [
      { key: 'videoPlay', label: 'Play video', hint: 'The video’s play button.' },
      { key: 'videoFrom', label: 'Untitled video', hint: 'The name of a video without a title.', fills: ['host'] },
      { key: 'videoLoads', label: 'Player note', hint: 'Under the play button, saying where the player comes from.', fills: ['host'] },
      { key: 'tableRegion', label: 'Table', hint: 'The name screen readers give a table without a caption or heading.' },
      { key: 'redirect', label: 'Moved page', hint: 'The link on an old address, for browsers that do not go on by themselves.' }
    ]
  }
];

const EN: VisitorText = {
  skipLink: 'Skip to content',
  menuOpen: 'Open menu',
  menuClose: 'Close menu',
  mainNav: 'Main',
  home: 'Home',
  formSending: 'Sending…',
  formSendingStatus: 'Sending your message…',
  formNotConnected: 'This form is not connected to a form service yet, so it cannot be sent.',
  formDuplicateNames: 'Two fields of this form have the same name, so it cannot be sent.',
  formNoChoices: 'A question in this form has no answers to choose from yet, so it cannot be sent.',
  searchLandmark: 'Site search',
  searchLabel: 'Search for',
  searchButton: 'Search',
  searchSearching: 'Searching…',
  searchFailed: 'The search could not load. Reload the page and try again.',
  searchNone: 'No pages match “{query}”.',
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
  videoPlay: 'Play video',
  videoFrom: 'Video from {host}',
  videoLoads: 'Loads the player from {host}',
  tableRegion: 'Table',
  redirect: 'This page has moved. Continue to its new address.'
};

const AR: VisitorText = {
  skipLink: 'انتقل إلى المحتوى',
  menuOpen: 'فتح القائمة',
  menuClose: 'إغلاق القائمة',
  mainNav: 'القائمة الرئيسية',
  home: 'الصفحة الرئيسية',
  formSending: 'جارٍ الإرسال…',
  formSendingStatus: 'جارٍ إرسال رسالتك…',
  formNotConnected: 'هذا النموذج غير متصل بخدمة نماذج بعد، لذا لا يمكن إرساله.',
  formDuplicateNames: 'في هذا النموذج حقلان بالاسم نفسه، لذا لا يمكن إرساله.',
  formNoChoices: 'في هذا النموذج سؤال ليست له إجابات للاختيار منها بعد، لذا لا يمكن إرساله.',
  searchLandmark: 'البحث في الموقع',
  searchLabel: 'ابحث عن',
  searchButton: 'بحث',
  searchSearching: 'جارٍ البحث…',
  searchFailed: 'تعذّر تحميل البحث. أعد تحميل الصفحة وحاول مرة أخرى.',
  searchNone: 'لا توجد صفحات تطابق «{query}».',
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
  videoPlay: 'تشغيل الفيديو',
  videoFrom: 'فيديو من {host}',
  videoLoads: 'يُحمَّل المشغّل من {host}',
  tableRegion: 'جدول',
  redirect: 'نُقلت هذه الصفحة. تابع إلى عنوانها الجديد.'
};

const HE: VisitorText = {
  skipLink: 'דילוג לתוכן',
  menuOpen: 'פתיחת התפריט',
  menuClose: 'סגירת התפריט',
  mainNav: 'תפריט ראשי',
  home: 'דף הבית',
  formSending: 'בשליחה…',
  formSendingStatus: 'ההודעה שלך נשלחת…',
  formNotConnected: 'הטופס הזה עדיין לא מחובר לשירות טפסים, ולכן אי אפשר לשלוח אותו.',
  formDuplicateNames: 'לשני שדות בטופס הזה יש אותו שם, ולכן אי אפשר לשלוח אותו.',
  formNoChoices: 'לשאלה בטופס הזה עדיין אין תשובות לבחירה, ולכן אי אפשר לשלוח אותו.',
  searchLandmark: 'חיפוש באתר',
  searchLabel: 'חיפוש',
  searchButton: 'חיפוש',
  searchSearching: 'החיפוש מתבצע…',
  searchFailed: 'לא ניתן היה לטעון את החיפוש. יש לטעון מחדש את הדף ולנסות שוב.',
  searchNone: 'אין דפים שתואמים ל"{query}".',
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
  videoPlay: 'הפעלת הסרטון',
  videoFrom: 'סרטון מ-{host}',
  videoLoads: 'הנגן נטען מ-{host}',
  tableRegion: 'טבלה',
  redirect: 'הדף הזה הועבר. אפשר להמשיך לכתובת החדשה שלו.'
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
  if (!all || typeof all !== 'object' || Array.isArray(all) || !Object.hasOwn(all, language)) return {};
  const own = all[language];
  return own && typeof own === 'object' && !Array.isArray(own) ? own : {};
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
