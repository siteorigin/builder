/**
 * The contact details the catalogue's sections start with (Contact details, the shared footer). They are fictional:
 * a website that still shows them sends visitors' enquiries nowhere, so the export reviews them before publishing.
 */
export const SAMPLE_CONTACT = {
  email: 'hello@example.com',
  /** The telephone number as the sections show it, and as their links dial it. */
  phone: '+1 555 0134',
  phoneDial: '+15550134',
  address: '12 Harbor Lane, Millbrook'
} as const;

export type SampleContactKind = 'email' | 'phone' | 'address';

/** Each sample detail, by the value the review names it with, in the order the review lists them. */
export const SAMPLE_CONTACT_VALUES: Array<{ kind: SampleContactKind; value: string; label: string }> = [
  { kind: 'email', value: SAMPLE_CONTACT.email, label: 'Sample email address' },
  { kind: 'phone', value: SAMPLE_CONTACT.phone, label: 'Sample phone number' },
  { kind: 'address', value: SAMPLE_CONTACT.address, label: 'Sample street address' }
];

/** What may stand between the digits of a written telephone number: spaces (\s covers the non-breaking ones), dots, dashes and brackets. */
const DIAL_GAP = '[\\s().\\p{Pd}]*';
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Each sample detail as visitors may read it, found generously so none goes out unreviewed: the address not inside a
 * longer mailbox or domain (myhello@…, …example.com.au), the number's digits in order with any spacing, the street
 * address with any spacing.
 */
export const SAMPLE_PATTERNS: Record<SampleContactKind, RegExp> = {
  email: new RegExp(`(?<![\\p{L}\\p{N}_.+-])${escapeRe(SAMPLE_CONTACT.email)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'giu'),
  phone: new RegExp(`(?<![\\p{N}_+])(?:\\+${DIAL_GAP})?${[...SAMPLE_CONTACT.phoneDial.replace(/\D/g, '')].join(DIAL_GAP)}(?![\\p{N}_])`, 'gu'),
  address: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(SAMPLE_CONTACT.address).replace(/,\s*/g, ',\\s*').replace(/ +/g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'giu')
};

/**
 * Whether words hold one of the sample details, as the export's review of them finds it (SAMPLE_PATTERNS): what that
 * review names already, so no other check names it again.
 */
export function holdsSampleContact(text: string): boolean {
  return Object.values(SAMPLE_PATTERNS).some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(text));
}
