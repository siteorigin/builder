/**
 * Component Studio: a component edited everywhere, shown on its own in the editor's isolated preview (see
 * @shared/component-preview) rather than through a placement on a page, so a component placed nowhere (or used only
 * inside other designs) has a canvas too. What the studio shows (the variant option on each axis, the sample content,
 * the value of each UI state variable) is the author's view, never saved: only edits to the design itself change the
 * project.
 */
import type { ComponentDefinition } from '@shared/types';
import { declaredState } from '@engine/schema';
import type { ComponentPreviewSpec } from '@shared/component-preview';
import { axesOf } from '@shared/variants';
import { studioSampleProps, type StudioSample } from './studio-samples';

/** What the studio shows the component with. Kept in the view only: never in the project, its history or the chat. */
export interface StudioView {
  /** The option shown on each variant axis, by axis ID; an axis left out (or naming an option gone since) shows its default. */
  variants: Record<string, string>;
  sample: StudioSample;
  /**
   * The value each UI state variable is previewed at, by name (a hidden tab chosen, a drawer open); one left out, or
   * naming a value the state no longer has, shows where the design starts it.
   */
  states?: Record<string, boolean | string>;
}

/** The component edited everywhere, the page that editing returns to, and (in Component Studio) how it is shown. */
export type DefinitionMode = { definitionId: string; returnPageId: string; studio?: StudioView } | null;

export const NEW_STUDIO: StudioView = { variants: {}, sample: 'defaults' };

/** The variant look the Inspector is styling (see ContractControls' styleVariant), when it is one of `def`'s. */
type Styled = { definitionId: string; axis: string; variant: string } | null | undefined;

/**
 * What the studio shows on each axis: the look being styled on its axis (so a style is set on what is shown), the
 * author's choice on the others, and the axis default where neither names an option the component still has.
 */
export function studioVariants(def: ComponentDefinition, view: StudioView, styled?: Styled): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [axis, a] of axesOf(def)) {
    const mine = styled && styled.definitionId === def.id && styled.axis === axis ? styled.variant : view.variants[axis];
    out[axis] = typeof mine === 'string' && Object.hasOwn(a.options, mine) ? mine : a.default;
  }
  return out;
}

/**
 * What the studio shows each of the design's UI state variables at, by name: the author's choice while the state can
 * still hold it, else where the design starts it. A declaration a hand edit damaged is left out.
 */
export function studioStates(def: ComponentDefinition, view: StudioView): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  if (def.kind !== 'managed' || !def.state || typeof def.state !== 'object') return out;
  for (const name of Object.keys(def.state)) {
    const declared = declaredState(def, name);
    if (!declared) continue;
    const mine = view.states && Object.hasOwn(view.states, name) ? view.states[name] : undefined;
    const fits = declared.type === 'boolean' ? typeof mine === 'boolean' : typeof mine === 'string' && declared.options.some((o) => o.value === mine);
    out[name] = fits ? mine! : declared.initial;
  }
  return out;
}

/** The isolated preview request for what the studio shows: the design, its variant options, its sample content and its UI state. */
export function studioSpec(def: ComponentDefinition, view: StudioView, styled?: Styled): ComponentPreviewSpec {
  const all = studioVariants(def, view, styled);
  // Defaults are left out, so the same look is always the same request; so are states at their starting value.
  const defaults = new Map(axesOf(def).map(([axis, a]) => [axis, a.default]));
  const variants = Object.fromEntries(Object.entries(all).filter(([axis, v]) => defaults.get(axis) !== v));
  const states = Object.fromEntries(Object.entries(studioStates(def, view)).filter(([name, v]) => declaredState(def, name)?.initial !== v));
  const props = studioSampleProps(def, view.sample);
  return { definitionId: def.id, ...(Object.keys(variants).length ? { variants } : {}), ...(props ? { props } : {}), ...(Object.keys(states).length ? { states } : {}) };
}

/**
 * The previews the studio's frame is given, one after another. Every request is numbered and only the latest one's
 * preview goes into the frame; one prepared after a later request was made is released at once, and the frame's
 * previous preview is released as the next one replaces it (the frame starts again for each). `end` releases
 * whatever is still held. Each preview's files stay in the project's dev cache until released.
 */
export class StudioLoads {
  private request = 0;
  private key: string | null = null;
  constructor(private readonly release: (key: string) => void) {}

  /** A new request: any still being prepared is out of date from now on. */
  begin(): number {
    return ++this.request;
  }

  /** Requests still being prepared are out of date, with no new one yet (the frame keeps what it shows). */
  supersede(): void {
    this.request++;
  }

  /** Whether `request` is still the latest. */
  latest(request: number): boolean {
    return request === this.request;
  }

  /** A request's preview is ready to show: true to put it in the frame, false (and released) when a later request has been made. */
  prepared(request: number, key: string): boolean {
    if (request !== this.request) {
      this.release(key);
      return false;
    }
    if (this.key && this.key !== key) this.release(this.key);
    this.key = key;
    return true;
  }

  /** Whether the frame's report is about the preview it was last given. */
  shows(key: unknown): boolean {
    return typeof key === 'string' && key === this.key;
  }

  /** The studio closes (or its frame goes): no request is the latest any more, and the preview shown is released. */
  end(): void {
    this.request++;
    if (this.key) this.release(this.key);
    this.key = null;
  }
}
