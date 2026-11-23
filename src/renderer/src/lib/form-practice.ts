/**
 * Forms in Preview (issue #193): what the preview bridge reports about the page's forms and their sends, and what the
 * editor says about them. In Preview a form's send is a practice run answered inside the page; only a live test the
 * author confirmed sends one real message.
 */

/** A form on the previewed page that posts, as the bridge lists it. */
export interface PreviewForm {
  /** Changes with the form's settings, so a live test confirmed for old settings no longer matches. */
  id: string;
  /** Its heading, or '' when it has none. */
  label: string;
  place: 'page' | 'header' | 'footer';
  /** `endpoint`: it posts to an address of its own; `netlify`: Netlify Forms; `none`: not connected yet. */
  service: 'endpoint' | 'netlify' | 'none';
  /** Where it posts, without the fragment; '' unless `service` is `endpoint`. */
  destination: string;
  /** Whether a live test can reach its service from the editor. */
  live: boolean;
}

/** The reply practice sends get. */
export type PracticeResult = 'success' | 'error';

/** What the bridge reported about one send. */
export interface FormSend {
  id: string;
  /** The live test it answers. */
  requestId?: string;
  kind: 'practice' | 'live';
  result: 'sending' | 'success' | 'error' | 'sent' | 'refused' | 'unreadable' | 'invalid' | 'not-sent' | 'unavailable';
  /** The service's HTTP status, for a live test that got a reply. */
  status?: number;
  /** Where a live test went. */
  destination?: string;
  /** Where the service passed a live test on to, when it redirected it. */
  redirected?: string;
}

/** The results each kind of send can report. */
const RESULTS: Record<FormSend['kind'], ReadonlySet<string>> = {
  practice: new Set(['sending', 'success', 'error']),
  live: new Set(['sending', 'sent', 'refused', 'unreadable', 'invalid', 'not-sent', 'unavailable'])
};
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The bridge's list of forms, or none when it is not one. */
export function formsOf(value: unknown): PreviewForm[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((f): PreviewForm[] => {
    if (!f || typeof f !== 'object') return [];
    const r = f as Record<string, unknown>;
    const id = str(r.id, 100);
    if (!id) return [];
    const service = r.service === 'endpoint' || r.service === 'netlify' ? r.service : 'none';
    const destination = service === 'endpoint' ? str(r.destination, 2000) : '';
    return [{ id, label: str(r.label, 80), place: r.place === 'header' || r.place === 'footer' ? r.place : 'page', service, destination, live: r.live === true && !!destination }];
  });
}

/** The bridge's report of a send, or null when it is not one. */
export function formSendOf(p: Record<string, unknown>): FormSend | null {
  const kind = p.kind === 'practice' || p.kind === 'live' ? p.kind : null;
  const result = kind && typeof p.result === 'string' && RESULTS[kind].has(p.result) ? (p.result as FormSend['result']) : null;
  const id = str(p.id, 100);
  if (!kind || !result || !id) return null;
  const status = typeof p.status === 'number' && Number.isInteger(p.status) && p.status >= 100 && p.status < 600 ? p.status : undefined;
  // A reply from the service is the only way a live test is sent or refused.
  if ((result === 'sent' || result === 'refused') && status === undefined) return null;
  return { id, requestId: str(p.requestId, 100) || undefined, kind, result, status, destination: str(p.destination, 2000) || undefined, redirected: str(p.redirected, 2000) || undefined };
}

/** An address as the author reads it: host, path and query, without the scheme. */
export function shortDestination(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' && !u.search ? '' : u.pathname) + u.search;
  } catch {
    return url;
  }
}

/** A form as the editor names it: by its heading, and where it is when that is the header or footer. */
export function formName(form: PreviewForm): string {
  const where = form.place === 'page' ? '' : ` in the ${form.place}`;
  return form.label ? `“${form.label}”${where}` : `The form${where}`;
}

/** Where a form sends once the site is published, said before the author sends anything. */
export function formDestinationNote(form: PreviewForm): string {
  const name = formName(form);
  if (form.service === 'netlify') return `${name} sends to Netlify Forms once the site is deployed on Netlify. Test delivery there.`;
  if (form.service === 'endpoint') return `On the published site, ${lower(name)} sends to ${shortDestination(form.destination)}.`;
  return `${name} is not connected to a form service yet.`;
}

const lower = (name: string) => (name.startsWith('The form') ? 'the form' + name.slice('The form'.length) : name);

/** What happened to a send, in the editor's words. */
export function formSendNote(send: FormSend, form?: PreviewForm): string {
  const to = send.destination || form?.destination;
  const where = to ? shortDestination(to) : 'the form service';
  if (send.kind === 'practice') {
    if (send.result === 'sending') return 'Practising a send. Nothing is being sent.';
    return `Practice send: the form showed its ${send.result === 'error' ? 'error' : 'sent'} message. Nothing was sent.`;
  }
  switch (send.result) {
    case 'sending':
      return `Sending one real test message to ${where}…`;
    case 'sent':
      return `Live test sent to ${where}${passedOn(send)}. The service answered with status ${send.status}. Check the service to see the message arrived.`;
    case 'refused':
      return `Live test sent to ${where}${passedOn(send)}, but the service answered with status ${send.status}. Check the form’s settings with the service.`;
    case 'unreadable':
      return `The live test to ${where} got no reply the editor could read. The message may still have arrived: check the service before you test again.`;
    case 'invalid':
      return 'Nothing was sent: the form has answers missing or not valid. Correct them and test again.';
    case 'unavailable':
      return 'Nothing was sent: the form or its settings changed. Check them and test again.';
    default:
      return 'Nothing was sent: the form did not send its message.';
  }
}

/** Where the service passed a live test on to, when it did. */
const passedOn = (send: FormSend) => (send.redirected ? `, which passed it on to ${shortDestination(send.redirected)}` : '');

/** Whether a send's report is the last word on it, rather than one saying it has started. */
export const sendSettled = (send: FormSend) => send.result !== 'sending';
