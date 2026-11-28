/**
 * The contact details the catalogue's sections start with (Contact details, the shared footer). They are fictional:
 * a website that still shows them sends visitors' enquiries nowhere, so the export reviews them before publishing.
 */
export const SAMPLE_CONTACT = {
  email: 'hello@example.com',
  /** The telephone number as the sections show it, and as their links dial it. */
  phone: '+1 555 0134',
  phoneDial: '+15550134',
  address: '12 Harbor Lane, Millbrook',
  /** The opening hours Contact details shows: plausible ones, so the export review does not list them. */
  hours: 'Monday to Friday, 9am – 5pm'
} as const;

export type SampleContactKind = 'email' | 'phone' | 'address';

/** Each sample detail, by the value the review names it with, in the order the review lists them. */
export const SAMPLE_CONTACT_VALUES: Array<{ kind: SampleContactKind; value: string; label: string }> = [
  { kind: 'email', value: SAMPLE_CONTACT.email, label: 'Sample email address' },
  { kind: 'phone', value: SAMPLE_CONTACT.phone, label: 'Sample phone number' },
  { kind: 'address', value: SAMPLE_CONTACT.address, label: 'Sample street address' }
];
