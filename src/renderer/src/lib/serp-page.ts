/**
 * The results page a search result is previewed on (#704): its size on each screen, how far it is scaled down to fit
 * where it shows, how a viewer likes to see it, and the generic results around the document's own.
 */
import { SERP_LAYOUT, type SerpDevice } from '@shared/serp';

/** The room beside the results column: the page's margins, and on a phone the edge of the phone too. */
export const SERP_MARGIN = 20;
export const PHONE_BEZEL = 8;

/** The results column: as wide as the title line the cuts are measured against, so lines break where they would there. */
export const serpColumnWidth = (device: SerpDevice): number => SERP_LAYOUT[device].titleLine;

/** The whole of what is drawn: the column and its margins, and on a phone the frame around them. */
export const serpPageWidth = (device: SerpDevice): number => serpColumnWidth(device) + 2 * SERP_MARGIN + (device === 'mobile' ? 2 * PHONE_BEZEL : 0);

/**
 * How far the page is scaled to show whole in `available` pixels: its real size wherever there is room, never larger.
 * Real size too while the room is unknown (nothing laid out yet, or a panel that is hidden).
 */
export function serpScale(available: number, device: SerpDevice): number {
  const width = serpPageWidth(device);
  return available > 0 && available < width ? available / width : 1;
}

/** Which screen's results show, and whether in the results page's dark theme. */
export interface SerpView {
  device: SerpDevice;
  dark: boolean;
}

export const SERP_VIEW_KEY = 'siteorigin.serpView';

/** A saved choice as read back; anything else is a computer's results page, light whatever the editor's appearance. */
export function parseSerpView(saved: string | null | undefined): SerpView {
  let v: unknown;
  try {
    v = JSON.parse(saved ?? 'null');
  } catch {
    v = null;
  }
  const o = v && typeof v === 'object' ? (v as Partial<Record<keyof SerpView, unknown>>) : {};
  return { device: o.device === 'mobile' ? 'mobile' : 'desktop', dark: o.dark === true };
}

/** The query in the sample results page's search bar. */
export const SAMPLE_QUERY = 'sample search';

export interface FillerResult {
  site: string;
  url: string;
  title: string;
  description: string;
}

/**
 * Stand-ins for the other results, on the domains reserved for examples: believable search copy of the usual lengths,
 * so the owner's result is read against results like it rather than against text about placeholders. The first shows above the
 * document's own result and the rest below it.
 */
export const FILLER_RESULTS: readonly FillerResult[] = [
  {
    site: 'Example Co.',
    url: 'example.com › services',
    title: 'Services and prices · Example Co.',
    description: 'What we offer, what it costs and how to book, with answers to the questions customers ask most before they get in touch.'
  },
  {
    site: 'Example Guides',
    url: 'example.org › guides › choosing',
    title: 'How to choose the right local business for the job',
    description: 'Five questions worth asking before you book, from what the price includes to how long the work usually takes.'
  },
  {
    site: 'Example Reviews',
    url: 'example.net › reviews',
    title: 'Customer reviews and ratings for local businesses near you',
    description: 'Read what customers say about service, value and quality, compare ratings side by side and leave a review of your own.'
  }
];
