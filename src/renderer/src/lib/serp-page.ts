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
 * Stand-ins for the other results, plainly made up, on the domains reserved for examples. The first shows above the
 * document's own result and the rest below it.
 */
export const FILLER_RESULTS: readonly FillerResult[] = [
  {
    site: 'Example Site',
    url: 'example.com › sample-page',
    title: 'Sample result title from an example website',
    description: 'Placeholder text standing in for another result’s description, so you can compare how yours reads beside it.'
  },
  {
    site: 'Another Example',
    url: 'example.org › guides › sample',
    title: 'Another placeholder result',
    description: 'This is not a real page. It fills the space a second site would take in a list of search results.'
  },
  {
    site: 'Placeholder Site',
    url: 'example.net › articles',
    title: 'A third sample result with a slightly longer title',
    description: 'More placeholder text, long enough to run on to a second line the way many descriptions do in a list of results.'
  }
];
