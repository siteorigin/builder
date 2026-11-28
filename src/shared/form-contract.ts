/**
 * The form contract: what the editor, the checks and the generator know about a theme's forms. It names the form
 * components, says how they connect to a service and name their answers, and holds the snippets of their Svelte
 * source that say a definition (or a project's copy of one) still does it that way. A theme's own definitions are
 * built from these, so the two cannot drift apart.
 *
 * Those snippets are theme code, copied into exported websites with the form: like the themes, they are MIT-0.
 */
import type { ComponentDefinition } from '@shared/types';
import { isBinding } from '@shared/types';

/**
 * The theme's forms: the Contact form, a page section, and the Signup form, a block. They share one source, the same
 * service settings and the same checks, so every rule about a form reads them through this.
 */
export const FORM_CONTRACTS: readonly string[] = ['contact.form', 'block.signup'];

/** Whether a contract (a component ID, or the one a copy's provenance names) is one of the theme's forms. */
export const isFormContract = (componentId: unknown): boolean => typeof componentId === 'string' && FORM_CONTRACTS.includes(componentId);

/** Whether a definition is one of the theme's forms or a project copy of one (made unique), by the contract it names. */
export const isFormDefinition = (def: Pick<ComponentDefinition, 'componentId' | 'provenance'> | undefined): boolean =>
  !!def && (isFormContract(def.componentId) || isFormContract(def.provenance?.componentId));

/** What a form is called in a finding: the signup form, else the contact form. A copy goes by the form it came from. */
export const formNoun = (def: Pick<ComponentDefinition, 'componentId' | 'provenance'> | undefined): string =>
  def?.componentId === 'block.signup' || def?.provenance?.componentId === 'block.signup' ? 'signup form' : 'contact form';

/** Hidden "honeypot" field names each service recognises as spam traps. */
export const FORM_PROVIDERS: Array<[string, string]> = [
  ['endpoint', 'Form endpoint (Formspree, Basin, Getform…)'],
  ['web3forms', 'Web3Forms'],
  ['netlify', 'Netlify Forms']
];

/**
 * How the contact form names each answer it sends: the reserved names, then the key for one field (its name, else
 * its label, else its position). Every version of the theme's form so far carries these two snippets exactly, so the
 * editor can tell a form that names its fields this way from custom code that may name them differently.
 * `formFieldKey` below is the same rule for the editor; tests/unit/form-keys.test.ts runs both on the same fields.
 */
export const RESERVED_SOURCE = `	// Names the services or the form itself use; a visible field never takes one of them.
	const RESERVED = ['_gotcha', 'botcheck', 'bot-field', 'form-name', 'access_key', 'subject', 'from_name', 'redirect'];`;
export const FIELD_NAME_SOURCE = `	function fieldName(field, i) {
		const slug = String(field.name || field.label || '')
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, '-')
			.replace(/^-+|-+$/g, '');
		const name = slug || 'field-' + (i + 1);
		return RESERVED.includes(name) ? name + '-field' : name;
	}`;
/** The form refuses to send while two of its fields share a key; forms from before this check send both. */
export const AMBIGUOUS_SOURCE = `	const ambiguous = $derived(new Set(names).size < names.length);`;
/** The form refuses to send while a single-choice question or a dropdown offers nothing to choose; older forms ask none. */
export const UNCHOOSABLE_SOURCE = `	const unchoosable = $derived((fields ?? []).some((field) => (field?.type === 'choice' || field?.type === 'select') && !choicesOf(field).length));`;

/**
 * How the form reads its service settings, and when they connect it. Every version of the theme's form so far has
 * both exactly, so the inspector can tell a form that uses the settings this way from code that may not.
 */
export const SERVICE_SOURCE = `	const key = $derived(String(accessKey ?? '').trim());
	const netlifyName = $derived(String(formName ?? '').trim());
	const action = $derived(provider === 'web3forms' ? 'https://api.web3forms.com/submit' : provider === 'endpoint' && isEndpoint(endpoint) ? endpoint.trim() : undefined);`;
export const CONNECTED_SOURCE = `provider === 'netlify' ? !!netlifyName : provider === 'web3forms' ? !!key : !!action`;

/** Whether a contact form instance is connected to a form service. Mirrors the component's own `connected`. */
export function formConnected(props: Record<string, unknown>): boolean {
  const provider = String(props.provider ?? 'endpoint');
  if (provider === 'netlify') return !!String(props.formName ?? '').trim();
  if (provider === 'web3forms') return !!String(props.accessKey ?? '').trim();
  if (provider !== 'endpoint') return false;
  return isHttpsEndpoint(props.endpoint);
}

/** The component's `isEndpoint`: a full HTTPS address. */
function isHttpsEndpoint(value: unknown): boolean {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

/**
 * The one setting each form service needs, how to get it, and what the editor says until it is filled in.
 * `invalid` is for text that is there but cannot work (an endpoint that is not a full HTTPS address).
 */
export const FORM_SERVICES: Record<string, { prop: string; setup: string; missing: string; invalid?: string }> = {
  endpoint: {
    prop: 'endpoint',
    setup: 'Create a form with Formspree, Basin, Getform or a similar service and paste the HTTPS endpoint it gives you, such as https://formspree.io/f/abc123.',
    missing: 'Add the HTTPS endpoint your form service gives you.',
    invalid: 'Use the full HTTPS endpoint your form service gives you, starting with https://.'
  },
  web3forms: {
    prop: 'accessKey',
    setup: 'Enter the email address messages should go to at web3forms.com, and Web3Forms emails you an access key. The key is public by design: it can only send messages to that address.',
    missing: 'Add your Web3Forms access key.'
  },
  netlify: {
    prop: 'formName',
    setup: 'Works when the site is hosted on Netlify: turn on form detection under Forms in the site’s Netlify settings, then deploy. Messages are listed there under this name, so give each form on the site its own.',
    missing: 'Add a form name for Netlify Forms.'
  }
};

const SERVICE_SETTINGS = Object.values(FORM_SERVICES).map((s) => s.prop);
/**
 * The settings that send a form's messages to someone's own account: an HTTPS endpoint, or a Web3Forms key (whose
 * owner gets the mail). A Netlify form's name sends to whichever site it is published on, so it is not among them.
 */
export const FORM_DESTINATIONS = ['endpoint', 'accessKey'] as const;

/**
 * Whether a definition reads its form service settings the way the theme's contact form does: any version of it, or
 * a project copy of it whose code still does. Code that reads them some other way keeps the ordinary inspector.
 */
export function readsFormServices(def: ComponentDefinition | undefined): def is ComponentDefinition {
  if (!def || def.kind !== 'code' || def.properties.provider?.type !== 'enum') return false;
  // A copy made unique takes a project component ID; its provenance still names the form it came from.
  if (!isFormContract(def.componentId) && !isFormContract(def.provenance?.componentId)) return false;
  if (SERVICE_SETTINGS.some((p) => def.properties[p]?.type !== 'string')) return false;
  return !!def.source?.includes(SERVICE_SOURCE) && def.source.includes(CONNECTED_SOURCE);
}

/**
 * Whether a definition is the theme's contact form, or a copy of it, going by the code it runs rather than the name it
 * gives itself: whatever a package calls it, form code that reads the service settings sends visitors' messages.
 */
export const sendsFormMessages = (def: ComponentDefinition | undefined): boolean => !!def && def.kind === 'code' && readsFormServices({ ...def, componentId: 'contact.form' });

/**
 * The value a placed form is exported with: its own, else the schema default (a stored null included). A value the
 * schema does not declare is not exported at all.
 */
function exported(def: ComponentDefinition, props: Record<string, unknown>, key: string): unknown {
  const schema = Object.hasOwn(def.properties, key) ? def.properties[key] : undefined;
  return schema ? (props[key] ?? schema.default) : undefined;
}

/**
 * Why a contact form cannot send, in the words of its selected service's setting, or of the service itself when it
 * is one the form does not know. Undefined once it can send, or when the service or its setting is bound from
 * outside and only known where the form is placed. `props` are the instance's own values.
 */
export function formConnectionProblem(def: ComponentDefinition, props: Record<string, unknown>): string | undefined {
  const provider = exported(def, props, 'provider');
  if (isBinding(provider)) return undefined;
  if (typeof provider !== 'string' || !Object.hasOwn(FORM_SERVICES, provider)) return 'Choose a form service and add the setting it needs.';
  const service = FORM_SERVICES[provider];
  const value = exported(def, props, service.prop);
  if (isBinding(value)) return undefined;
  if (formConnected({ provider, [service.prop]: value })) return undefined;
  return service.invalid && text(value ?? '').trim() ? service.invalid : service.missing;
}

/**
 * The Netlify form name a placed contact form submits under, trimmed as the component trims it, or undefined when it
 * does not send to Netlify Forms (or has no name yet). `props` are the placement's effective values.
 */
export function netlifyFormName(def: ComponentDefinition, props: Record<string, unknown>): string | undefined {
  // The theme's contact form or a copy of it, whatever its code now looks like: its settings are what it is sent with.
  if (def.kind !== 'code' || (!isFormContract(def.componentId) && !isFormContract(def.provenance?.componentId))) return undefined;
  if (def.properties.provider?.type !== 'enum' || def.properties.formName?.type !== 'string') return undefined;
  if (exported(def, props, 'provider') !== 'netlify') return undefined;
  const name = exported(def, props, 'formName');
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

/** What the inspector shows for a contact form's service: the selected service's setting, and the others to hide. */
export interface FormServiceSetup {
  /** The property the selected service needs. */
  prop: string;
  /** The other services' settings. Hidden, not cleared: switching back shows what was entered. */
  hidden: string[];
  /** How to get the setting from the service. */
  setup: string;
  /** Why the form cannot send yet, while the setting is missing or unusable. */
  problem?: string;
}

/**
 * The selected service's setting for the inspector, or undefined when the settings cannot be sorted by service: a
 * definition that does not read them the way the theme's form does, a service bound from outside (two placements
 * can choose differently) or one the form does not know. Every setting shows then, as before.
 * `props` are the instance's own values.
 */
export function formServiceSetup(def: ComponentDefinition | undefined, props: Record<string, unknown>): FormServiceSetup | undefined {
  if (!readsFormServices(def)) return undefined;
  const provider = exported(def, props, 'provider');
  if (typeof provider !== 'string' || !Object.hasOwn(FORM_SERVICES, provider)) return undefined;
  const service = FORM_SERVICES[provider];
  return { prop: service.prop, hidden: SERVICE_SETTINGS.filter((p) => p !== service.prop), setup: service.setup, problem: formConnectionProblem(def, props) };
}

/** Names a field may not be sent under: the component's `RESERVED`. */
const RESERVED_KEYS = ['_gotcha', 'botcheck', 'bot-field', 'form-name', 'access_key', 'subject', 'from_name', 'redirect'];

/** A contact form field as the component reads it. */
export interface FormField {
  id?: unknown;
  name?: unknown;
  label?: unknown;
  type?: unknown;
  options?: unknown;
}

/** `String(value)`, or '' for a stored value that has no text form (a hand-edited document can hold anything). */
function text(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The key the component sends one field's answer under: its `fieldName`, exactly. */
export function formFieldKey(field: FormField, index: number): string {
  const name = slug(text(field.name || field.label || '')) || `field-${index + 1}`;
  return RESERVED_KEYS.includes(name) ? `${name}-field` : name;
}

/** The key typed text makes on its own, or '' when nothing of it survives and the field's position would decide. */
export function formKeyFrom(text: string): string {
  const name = slug(text);
  return !name ? '' : RESERVED_KEYS.includes(name) ? `${name}-field` : name;
}

/** Whether a field's own name decides its key, rather than its label or its position in the form. */
export function formNameDecides(field: FormField): boolean {
  return !!field.name && !!formKeyFrom(String(field.name));
}

/** Keys shared by more than one field of a form, each with the positions of the fields that share it, in order. */
export function formKeyClashes(fields: readonly FormField[]): Array<{ key: string; indexes: number[] }> {
  const by = new Map<string, number[]>();
  fields.forEach((f, i) => {
    const key = formFieldKey(f ?? {}, i);
    by.set(key, [...(by.get(key) ?? []), i]);
  });
  return [...by].filter(([, indexes]) => indexes.length > 1).map(([key, indexes]) => ({ key, indexes }));
}

/**
 * “Email” and “Phone”: the fields at `indexes`, by label, and by position too where a label is empty or another
 * field in `among` has the same one.
 */
export function formFieldTitles(fields: readonly FormField[], indexes: readonly number[], among: readonly number[] = indexes): string {
  const label = (i: number) => text(fields[i]?.label ?? '').trim();
  const names = indexes.map((i) => {
    const l = label(i);
    if (!l) return `field ${i + 1}`;
    return among.some((j) => j !== i && label(j).toLowerCase() === l.toLowerCase()) ? `“${l}” (field ${i + 1})` : `“${l}”`;
  });
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What the field editor says under a field's name: the key it is sent under, and any other field sent under it too. */
export function formKeyNote(fields: readonly FormField[], index: number): { hint: string; error?: string } {
  const key = formFieldKey(fields[index] ?? {}, index);
  const clash = formKeyClashes(fields).find((c) => c.indexes.includes(index));
  const others = clash?.indexes.filter((j) => j !== index) ?? [];
  return {
    hint: `Sent as “${key}”. Changing the label keeps it; clear it to make a new one from the label.`,
    error: others.length ? `${formFieldTitles(fields, others, fields.map((_, j) => j))} ${others.length === 1 ? 'is' : 'are'} also sent as “${key}”. Give each field its own name.` : undefined
  };
}

/**
 * A form's fields as the export hands them to the component: a missing list is the definition's, and a missing
 * name or label is the field's default, exactly as the generator's `resolveValue` fills them in.
 */
export function formFieldsAsSent(def: ComponentDefinition, value: unknown): FormField[] {
  const schema = def.properties.fields;
  if (schema?.type !== 'list') return [];
  const items = (Array.isArray(value) ? value : schema.default) as Array<Record<string, unknown> | null | undefined>;
  const f = schema.fields;
  return items.map((it) => ({ id: it?.id, name: it?.name ?? f.name?.default, label: it?.label ?? f.label?.default, type: it?.type ?? f.type?.default, options: it?.options ?? f.options?.default }));
}

/**
 * Whether a definition names its form fields the way the theme's contact form does, in any version so far. Custom
 * code may name them differently, so the editor shows and keeps keys only for a definition this says yes to.
 */
export function namesFormFields(def: ComponentDefinition | undefined): boolean {
  return !!def && def.kind === 'code' && isFormContract(def.componentId) && def.properties.fields?.type === 'list' && !!def.source?.includes(RESERVED_SOURCE) && def.source.includes(FIELD_NAME_SOURCE);
}

/** Whether the form refuses to send while two fields share a key. Older versions send both answers. */
export function formRefusesClashes(def: ComponentDefinition): boolean {
  return !!def.source?.includes(AMBIGUOUS_SOURCE);
}

/**
 * Whether a definition's fields can be single-choice questions and checkboxes, with a question's answers in its
 * `options`. Older versions of the form have neither, and their editor offers neither.
 */
export function offersFormChoices(def: ComponentDefinition | undefined): boolean {
  const fields = def?.properties.fields;
  if (!namesFormFields(def) || fields?.type !== 'list') return false;
  const type = fields.fields.type;
  return fields.fields.options?.type === 'choices' && type?.type === 'enum' && type.options.some((o) => o.value === 'choice');
}

/** The field types that ask the visitor to pick one of the field's `options`: radio buttons, and a dropdown. */
const CHOOSING_TYPES = ['choice', 'select'];

/**
 * A field's settings that do nothing for its type. The editor hides them and keeps what they hold for a switch back.
 * A dropdown's placeholder is what it shows until an answer is picked; a date or time picker shows none. Only a hidden
 * field sends a value of its own, and it has nothing to require.
 */
export function formFieldSettingsHidden(field: FormField): string[] {
  const type = text(field.type ?? 'text');
  if (type === 'choice') return ['placeholder', 'value'];
  if (type === 'select') return ['value'];
  if (type === 'checkbox' || type === 'date' || type === 'time') return ['placeholder', 'options', 'value'];
  if (type === 'hidden') return ['placeholder', 'options', 'required'];
  return ['options', 'value'];
}

/**
 * The positions of a form's single-choice questions and dropdowns that offer nothing to choose: the component's
 * `unchoosable`.
 */
export function formUnchoosable(fields: readonly FormField[]): number[] {
  const offered = (options: unknown) => Array.isArray(options) && options.some((o) => !!o && !!text((o as { label?: unknown }).label ?? '').trim());
  return fields.flatMap((f, i) => (CHOOSING_TYPES.includes(f?.type as string) && !offered(f.options) ? [i] : []));
}

/** Whether the form refuses to send while a single-choice question has no choices. */
export function formRefusesUnchoosable(def: ComponentDefinition): boolean {
  return !!def.source?.includes(UNCHOOSABLE_SOURCE);
}
