import type { ExternalLink } from '@shared/links';
import { api, confirmDialog } from '../store';

/**
 * Open a link outside the app once the person has seen where it goes: a web page in the browser, an address in the
 * email app, a number in the phone app. The link may come from somewhere the editor doesn't control (the previewed
 * site, the model's reply), so the confirmation shows its real target, whatever words it was shown as.
 */
export function confirmOpenExternal(link: ExternalLink): void {
  const ask =
    link.kind === 'email'
      ? { title: 'Write an email?', confirmLabel: 'Open email app', body: 'A new email to this address opens in your email app.' }
      : link.kind === 'phone'
        ? // The button opens the phone app; it never places the call itself.
          { title: 'Open this number in your phone app?', confirmLabel: 'Open phone app', body: 'Your phone app opens, ready to call this number.' }
        : { title: 'Open this link in your browser?', confirmLabel: 'Open in browser', body: 'It opens in your web browser, outside SiteOrigin Builder.' };
  void confirmDialog({ ...ask, subject: link.target, subjectKind: link.kind, icon: link.kind }).then((ok) => ok === true && void api.app.openExternal(link.href));
}
