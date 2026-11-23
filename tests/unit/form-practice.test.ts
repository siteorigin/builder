import { describe, expect, it } from 'vitest';
import { formDestinationNote, formName, formSendNote, formSendOf, formsOf, sendSettled, shortDestination, type PreviewForm } from '../../src/renderer/src/lib/form-practice';

const FORM: PreviewForm = { id: 'a-1-x', label: 'Send us a message', place: 'page', service: 'endpoint', destination: 'https://formspree.io/f/abc123', live: true };

describe('forms in Preview, as the editor reads the preview bridge (issue #193)', () => {
  it('reads the listed forms, and nothing that is not one', () => {
    expect(formsOf([FORM])).toEqual([FORM]);
    expect(formsOf('forms')).toEqual([]);
    expect(formsOf([null, 3, { label: 'No id' }])).toEqual([]);
    // A form that does not send to an address of its own can never be tested live, whatever the page says.
    expect(formsOf([{ id: 'n', service: 'netlify', destination: 'https://elsewhere.test/', live: true }])).toEqual([{ id: 'n', label: '', place: 'page', service: 'netlify', destination: '', live: false }]);
    expect(formsOf([{ id: 'u', service: 'mystery', place: 'sidebar' }])).toEqual([{ id: 'u', label: '', place: 'page', service: 'none', destination: '', live: false }]);
    expect(formsOf(Array.from({ length: 30 }, (_, i) => ({ ...FORM, id: `f${i}` })))).toHaveLength(20);
  });

  it('reads a send report, and refuses one it does not know', () => {
    expect(formSendOf({ id: 'a', kind: 'practice', result: 'success' })).toEqual({ id: 'a', requestId: undefined, kind: 'practice', result: 'success', status: undefined, destination: undefined });
    expect(formSendOf({ id: 'a', requestId: 'live-1', kind: 'live', result: 'sent', status: 202, destination: FORM.destination })).toMatchObject({ requestId: 'live-1', status: 202, destination: FORM.destination });
    expect(formSendOf({ id: 'a', kind: 'live', result: 'sent', status: 'ok' })?.status).toBeUndefined();
    expect(formSendOf({ id: 'a', kind: 'visitor', result: 'success' })).toBeNull();
    expect(formSendOf({ id: 'a', kind: 'practice', result: 'delivered' })).toBeNull();
    expect(sendSettled({ id: 'a', kind: 'live', result: 'sending' })).toBe(false);
    expect(sendSettled({ id: 'a', kind: 'live', result: 'invalid' })).toBe(true);
  });

  it('names a form and says where it sends once published, before anything is sent', () => {
    expect(shortDestination('https://formspree.io/f/abc123')).toBe('formspree.io/f/abc123');
    expect(shortDestination('https://api.web3forms.com/')).toBe('api.web3forms.com');
    expect(formName(FORM)).toBe('“Send us a message”');
    expect(formName({ ...FORM, label: '', place: 'footer' })).toBe('The form in the footer');
    expect(formDestinationNote(FORM)).toBe('On the published site, “Send us a message” sends to formspree.io/f/abc123.');
    expect(formDestinationNote({ ...FORM, label: '' })).toBe('On the published site, the form sends to formspree.io/f/abc123.');
    expect(formDestinationNote({ ...FORM, service: 'netlify', destination: '', live: false })).toBe('“Send us a message” sends to Netlify Forms once the site is deployed on Netlify. Test delivery there.');
    expect(formDestinationNote({ ...FORM, service: 'none', destination: '', live: false })).toBe('“Send us a message” is not connected to a form service yet.');
  });

  it('says what a practice send did, and that nothing was sent', () => {
    expect(formSendNote({ id: FORM.id, kind: 'practice', result: 'sending' }, FORM)).toBe('Practising a send. Nothing is being sent.');
    expect(formSendNote({ id: FORM.id, kind: 'practice', result: 'success' }, FORM)).toBe('Practice send: the form showed its sent message. Nothing was sent.');
    expect(formSendNote({ id: FORM.id, kind: 'practice', result: 'error' }, FORM)).toBe('Practice send: the form showed its error message. Nothing was sent.');
  });

  it('says what a live test did, with what the service answered', () => {
    const live = { id: FORM.id, kind: 'live' as const, destination: FORM.destination };
    expect(formSendNote({ ...live, result: 'sending' })).toBe('Sending one real test message to formspree.io/f/abc123…');
    expect(formSendNote({ ...live, result: 'sent', status: 200 })).toBe('Live test sent to formspree.io/f/abc123. The service answered with status 200. Check the service to see the message arrived.');
    expect(formSendNote({ ...live, result: 'refused', status: 422 })).toBe('Live test sent to formspree.io/f/abc123, but the service answered with status 422. Check the form’s settings with the service.');
    expect(formSendNote({ ...live, result: 'unreadable' })).toContain('The message may still have arrived');
    expect(formSendNote({ id: FORM.id, kind: 'live', result: 'invalid' })).toBe('Nothing was sent: the form has answers missing or not valid. Correct them and test again.');
    expect(formSendNote({ id: FORM.id, kind: 'live', result: 'unavailable' })).toBe('Nothing was sent: the form or its settings changed. Check them and test again.');
    expect(formSendNote({ id: FORM.id, kind: 'live', result: 'not-sent' })).toBe('Nothing was sent: the form did not send its message.');
    // Without a destination of its own, the report falls back to the form's.
    expect(formSendNote({ id: FORM.id, kind: 'live', result: 'sending' }, FORM)).toBe('Sending one real test message to formspree.io/f/abc123…');
  });
});
