import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION, isBinding } from '@shared/types';
import { P } from '../dsl';
import { FOUNDATION } from './pack';

/**
 * The theme's forms: the Contact form, a page section, and the Signup form, a block. They share one source, the same
 * service settings and the same checks, so every rule about a form reads them through this.
 */
export const FORM_CONTRACTS: readonly string[] = ['contact.form', 'block.signup'];

/** Whether a contract (a component ID, or the one a copy's provenance names) is one of the theme's forms. */
export const isFormContract = (componentId: unknown): boolean => typeof componentId === 'string' && FORM_CONTRACTS.includes(componentId);

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
const RESERVED_SOURCE = `	// Names the services or the form itself use; a visible field never takes one of them.
	const RESERVED = ['_gotcha', 'botcheck', 'bot-field', 'form-name', 'access_key', 'subject', 'from_name', 'redirect'];`;
const FIELD_NAME_SOURCE = `	function fieldName(field, i) {
		const slug = String(field.name || field.label || '')
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, '-')
			.replace(/^-+|-+$/g, '');
		const name = slug || 'field-' + (i + 1);
		return RESERVED.includes(name) ? name + '-field' : name;
	}`;
/** The form refuses to send while two of its fields share a key; forms from before this check send both. */
const AMBIGUOUS_SOURCE = `	const ambiguous = $derived(new Set(names).size < names.length);`;
/** The form refuses to send while a single-choice question offers nothing to choose; older forms ask none. */
const UNCHOOSABLE_SOURCE = `	const unchoosable = $derived((fields ?? []).some((field) => field?.type === 'choice' && !choicesOf(field).length));`;

/**
 * How the form reads its service settings, and when they connect it. Every version of the theme's form so far has
 * both exactly, so the inspector can tell a form that uses the settings this way from code that may not.
 */
const SERVICE_SOURCE = `	const key = $derived(String(accessKey ?? '').trim());
	const netlifyName = $derived(String(formName ?? '').trim());
	const action = $derived(provider === 'web3forms' ? 'https://api.web3forms.com/submit' : provider === 'endpoint' && isEndpoint(endpoint) ? endpoint.trim() : undefined);`;
const CONNECTED_SOURCE = `provider === 'netlify' ? !!netlifyName : provider === 'web3forms' ? !!key : !!action`;

/**
 * The form's Svelte source. The Contact form is a page section; the Signup form a compact block, with the same
 * fields, services and checks in a card that fills the width it is given (no section padding, no page-width
 * container, one column of fields, a smaller heading).
 */
function formSource(kind: 'section' | 'block'): string {
  const block = kind === 'block';
  const root = block ? 'div' : 'section';
  const heading = block ? 'h3' : 'h2';
  return `<script>
	/**
	 * ${block ? 'Compact signup form (a block) that sends' : 'Contact form that sends'} messages to an external form service: an HTTPS form endpoint (Formspree, Basin,
	 * Getform and similar), Web3Forms or Netlify Forms. Foundation theme code component.
	 *
	 * Without JavaScript it is an ordinary form post. With JavaScript it sends in the background and reports
	 * the result in place. A hidden honeypot field catches most spam bots. Until the form is connected to a
	 * service it says so and cannot be sent: it never pretends to send. The same goes for two fields that share
	 * a name, whose answers the service could not tell apart, and for a single-choice question with nothing to
	 * choose from.
	 *
	 * A single-choice field is a group of radio buttons, each sent as the value its choice was given when it was
	 * first named. A checkbox is sent as "yes" when ticked and not at all otherwise; a required one must be ticked.
	 *
	 * data-keep-draft and data-draft-field let the site's layout keep a message the visitor has not sent with
	 * its place in the tab's history (src/lib/siteorigin/runtime/drafts.js), so Back brings it back.
	 */
	import { visitorText } from '../runtime/visitor-text.js';

	let {
		eyebrow = '',
		heading = '',
		lead = '',
		provider = 'endpoint',
		endpoint = '',
		accessKey = '',
		formName = 'contact',
		fields = [],
		submitLabel = '',
		successMessage = '',
		errorMessage = '',
		variant = 'default',
		class: className = ''
	} = $props();

	const uid = $props.id();
	let status = $state('idle');
	// What the form says of its own progress, in the language of the page.
	const text = visitorText();

	const HONEYPOT = { endpoint: '_gotcha', web3forms: 'botcheck', netlify: 'bot-field' };
${RESERVED_SOURCE}
	const AUTOCOMPLETE = { email: 'email', tel: 'tel' };
	const honeypot = $derived(HONEYPOT[provider] ?? '_gotcha');
${SERVICE_SOURCE}
	const connected = $derived(${CONNECTED_SOURCE});
	// The key each answer is sent under. Two answers under one key reach the service as one field twice.
	const names = $derived((fields ?? []).map((field, i) => fieldName(field, i)));
${AMBIGUOUS_SOURCE}
	// A required question with no choices could not be answered, and an optional one asks nothing.
${UNCHOOSABLE_SOURCE}
	const ready = $derived(connected && !ambiguous && !unchoosable);

	function isEndpoint(value) {
		try {
			const url = new URL(String(value ?? '').trim());
			return url.protocol === 'https:' && !!url.hostname;
		} catch {
			return false;
		}
	}

${FIELD_NAME_SOURCE}

	// The answers a single-choice field offers: each one's id, its label and the value it is sent as. The key keeps a
	// ticked radio button with its choice when the choices are reordered.
	function choicesOf(field) {
		const keys = new Set();
		return (Array.isArray(field?.options) ? field.options : [])
			.filter((choice) => choice && String(choice.label ?? '').trim())
			.map((choice, j) => {
				const id = String(choice.id ?? '');
				let key = id;
				for (let n = j; !key || keys.has(key); n++) key = '#' + n;
				keys.add(key);
				return { id, key, label: String(choice.label), value: String(choice.value || choice.label) };
			});
	}

	// The sent or error message describes the last attempt; once the visitor edits again it no longer does.
	function clearFeedback() {
		if (status === 'sent' || status === 'error') status = 'idle';
	}

	async function submit(event) {
		event.preventDefault();
		if (!ready || status === 'sending') return;
		const form = event.currentTarget;
		// The message as sent. The fields stay read-only until the reply, so the reset after a successful
		// send can never discard something the visitor typed in the meantime.
		const data = new FormData(form);
		// Bots fill in every field; people never see this one. Drop the message quietly.
		if (data.get(honeypot)) {
			HTMLFormElement.prototype.reset.call(form);
			status = 'sent';
			return;
		}
		status = 'sending';
		try {
			const response =
				provider === 'netlify'
					? await fetch(location.pathname, {
							method: 'POST',
							headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
							body: new URLSearchParams(data).toString()
						})
					: await fetch(action, { method: 'POST', headers: { Accept: 'application/json' }, body: data });
			if (!response.ok) throw new Error(String(response.status));
			// The prototype method, in case a field is named "reset".
			HTMLFormElement.prototype.reset.call(form);
			status = 'sent';
		} catch {
			status = 'error';
		}
	}
</script>

<${root} class={['so-form',${block ? " 'so-form--block'," : ''} 'so-form--' + variant, className]}>
	<div class="so-form__inner">
		{#if eyebrow || heading || lead}
			<div class="so-form__intro">
				{#if eyebrow}<p class="so-form__eyebrow">{eyebrow}</p>{/if}
				{#if heading}<${heading} class="so-form__heading" id={uid + '-heading'}>{heading}</${heading}>{/if}
				{#if lead}<p class="so-form__lead">{lead}</p>{/if}
			</div>
		{/if}
		<form
			class="so-form__form"
			method="POST"
			action={action}
			name={provider === 'netlify' ? netlifyName : undefined}
			data-netlify={provider === 'netlify' ? 'true' : undefined}
			netlify-honeypot={provider === 'netlify' ? honeypot : undefined}
			aria-labelledby={heading ? uid + '-heading' : undefined}
			aria-busy={status === 'sending'}
			data-keep-draft
			onsubmit={submit}
		>
			{#if provider === 'netlify'}<input type="hidden" name="form-name" value={netlifyName} />{/if}
			{#if provider === 'web3forms'}<input type="hidden" name="access_key" value={key} />{/if}
			{#each fields as field, i (field.id)}
				{#if field.type === 'choice'}
					<!-- Disabled while a message sends, as the text fields are read-only: its answers were already taken. -->
					<fieldset class="so-form__field so-form__field--wide so-form__choices" disabled={status === 'sending'}>
						<legend>
							{field.label}{#if field.required}<span class="so-form__required" aria-hidden="true">*</span>{/if}
						</legend>
						{#each choicesOf(field) as choice (choice.key)}
							<label class="so-form__choice">
								<input
									type="radio"
									name={names[i]}
									value={choice.value}
									data-draft-field={field.id ?? i}
									data-draft-choice={choice.id || undefined}
									required={field.required}
									oninput={clearFeedback}
								/>
								{choice.label}
							</label>
						{/each}
					</fieldset>
				{:else if field.type === 'checkbox'}
					<div class="so-form__field so-form__field--wide so-form__check">
						<input
							id={uid + '-' + i}
							type="checkbox"
							name={names[i]}
							value="yes"
							data-draft-field={field.id ?? i}
							required={field.required}
							disabled={status === 'sending'}
							oninput={clearFeedback}
						/>
						<label for={uid + '-' + i}>
							{field.label}{#if field.required}<span class="so-form__required" aria-hidden="true">*</span>{/if}
						</label>
					</div>
				{:else}
					<div class={['so-form__field', field.type === 'textarea' && 'so-form__field--wide']}>
						<label for={uid + '-' + i}>
							{field.label}{#if field.required}<span class="so-form__required" aria-hidden="true">*</span>{/if}
						</label>
						{#if field.type === 'textarea'}
							<textarea
								id={uid + '-' + i}
								name={names[i]}
								data-draft-field={field.id ?? i}
								required={field.required}
								readonly={status === 'sending'}
								rows="5"
								placeholder={field.placeholder || undefined}
								oninput={clearFeedback}
							></textarea>
						{:else}
							<input
								id={uid + '-' + i}
								type={field.type === 'email' || field.type === 'tel' ? field.type : 'text'}
								name={names[i]}
								data-draft-field={field.id ?? i}
								required={field.required}
								readonly={status === 'sending'}
								autocomplete={AUTOCOMPLETE[field.type] ?? (names[i] === 'name' ? 'name' : undefined)}
								placeholder={field.placeholder || undefined}
								oninput={clearFeedback}
							/>
						{/if}
					</div>
				{/if}
			{/each}
			<div class="so-form__trap" aria-hidden="true">
				{#if provider === 'web3forms'}
					<!-- Web3Forms' trap is a checkbox, which is only sent when ticked. -->
					<input type="checkbox" name={honeypot} tabindex="-1" autocomplete="off" />
				{:else}
					<label>Leave this field empty <input type="text" name={honeypot} tabindex="-1" autocomplete="off" /></label>
				{/if}
			</div>
			<div class="so-form__actions">
				<button class="so-btn so-btn--primary" type="submit" disabled={!ready || status === 'sending'}>
					{status === 'sending' ? text().formSending : submitLabel || text().formSubmit}
				</button>
			</div>
		</form>
		<!-- Live regions stay in the page, outside the busy form, so their changes are announced. -->
		<div class="so-form__messages">
			<p class="so-form__status" role="status">
				{#if !connected}{text().formNotConnected}{:else if ambiguous}{text().formDuplicateNames}{:else if unchoosable}{text().formNoChoices}{:else if status === 'sending'}{text().formSendingStatus}{:else if status === 'sent'}{successMessage || text().formSent}{/if}
			</p>
			<p class="so-form__status so-form__status--error" role="alert">
				{#if status === 'error'}{errorMessage || text().formFailed}{/if}
			</p>
		</div>
	</div>
</${root}>

<style>
	.so-form {
		padding-block: var(--so-space-section);
		padding-inline: var(--so-container-gutter);
		background: var(--so-color-background);
		color: var(--so-color-text);
	}
	.so-form--muted {
		background: var(--so-color-surface-alt);
	}
	.so-form--inverse {
		background: var(--so-color-inverse);
		color: var(--so-color-on-inverse);
	}
	.so-form__inner {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-2xl);
		max-width: var(--so-container-reading);
		margin-inline: auto;
	}
	.so-form__intro {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-md);
	}
	.so-form__eyebrow {
		font-family: var(--so-text-eyebrow-family);
		font-size: var(--so-text-eyebrow-size);
		font-weight: var(--so-text-eyebrow-weight);
		letter-spacing: var(--so-text-eyebrow-tracking);
		line-height: var(--so-text-eyebrow-line-height);
		text-transform: var(--so-text-eyebrow-transform, none);
		color: var(--so-color-brand);
	}
	.so-form--inverse .so-form__eyebrow {
		color: var(--so-color-accent);
	}
	.so-form__heading {
		font-family: var(--so-text-h2-family);
		font-size: var(--so-text-h2-size);
		font-weight: var(--so-text-h2-weight);
		letter-spacing: var(--so-text-h2-tracking);
		line-height: var(--so-text-h2-line-height);
	}
	.so-form__lead {
		font-size: var(--so-text-lead-size);
		line-height: var(--so-text-lead-line-height);
		color: var(--so-color-muted);
	}
	.so-form--inverse .so-form__lead {
		color: var(--so-color-on-inverse);
		opacity: 0.78;
	}
	.so-form__form {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--so-space-lg);
	}
	.so-form__field {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-xs);
		grid-column: span 2;
	}
	@media (min-width: 768px) {
		.so-form__field:not(.so-form__field--wide) {
			grid-column: span 1;
		}
	}
	.so-form__field label {
		font-size: 0.95rem;
		font-weight: 550;
	}
	.so-form__required {
		margin-inline-start: 0.2em;
	}
	.so-form__field input:not([type='radio']):not([type='checkbox']),
	.so-form__field textarea {
		width: 100%;
		min-height: 46px;
		padding: 0.65em 0.85em;
		/* Field outlines reach 3:1 against the section background (WCAG 1.4.11). */
		border: 1px solid color-mix(in srgb, var(--so-color-text) 55%, transparent);
		border-radius: var(--so-radius-sm);
		background: var(--so-color-surface);
		color: var(--so-color-text);
		font: inherit;
	}
	.so-form__field textarea {
		resize: vertical;
	}
	/* Email addresses and phone numbers are typed left to right, whichever way the page runs, and start at the side
	   the page's text does. */
	.so-form__field input:is([type='email'], [type='tel']) {
		direction: ltr;
	}
	.so-form__field:dir(rtl) input:is([type='email'], [type='tel']) {
		text-align: right;
	}
	.so-form__field input:focus-visible,
	.so-form__field textarea:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus));
		outline-offset: 1px;
	}
	.so-form__choices {
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.so-form__choices legend {
		margin-bottom: var(--so-space-xs);
		padding: 0;
		font-size: 0.95rem;
		font-weight: 550;
	}
	.so-form__field .so-form__choice {
		display: flex;
		align-items: flex-start;
		gap: 0.6em;
		padding-block: 0.2em;
		font-size: 1rem;
		font-weight: 400;
	}
	.so-form__check {
		flex-direction: row;
		align-items: flex-start;
		gap: 0.6em;
	}
	.so-form__choice input,
	.so-form__check input {
		flex: none;
		width: 1.15em;
		height: 1.15em;
		margin: 0.2em 0 0;
		accent-color: var(--so-color-brand);
	}
	.so-form__choice input:focus-visible,
	.so-form__check input:focus-visible {
		outline-offset: 2px;
	}
	/* Native radio buttons and checkboxes drawn for a dark background, so their outlines stay visible. */
	.so-form--inverse .so-form__choice input,
	.so-form--inverse .so-form__check input {
		color-scheme: dark;
	}
	.so-form__trap {
		/* Off the start edge: off the end, a right-to-left page would scroll to it. */
		position: absolute;
		inset-inline-start: -10000px;
		width: 1px;
		height: 1px;
		overflow: hidden;
	}
	.so-form__actions {
		grid-column: span 2;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--so-space-md);
	}
	.so-form__actions button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	.so-form__messages {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-xs);
		margin-top: calc(-1 * var(--so-space-lg));
	}
	.so-form__status {
		margin: 0;
	}
	.so-form__status--error {
		font-weight: 550;
	}${block ? BLOCK_CSS : ''}
</style>
`;
}

/** The Signup form's card: the section's padding and width give way to a card that fills its column. */
const BLOCK_CSS = `
	.so-form--block {
		width: 100%;
		min-width: 0;
		padding-block: var(--so-space-lg);
		padding-inline: var(--so-space-lg);
		background: var(--so-color-surface);
		border: var(--so-border-default);
		border-radius: var(--so-radius-lg);
	}
	.so-form--block.so-form--muted {
		background: var(--so-color-surface-alt);
		border: 0;
	}
	.so-form--block.so-form--inverse {
		background: var(--so-color-inverse);
		border: 0;
	}
	.so-form--block .so-form__inner {
		gap: var(--so-space-lg);
		max-width: none;
	}
	.so-form--block .so-form__intro {
		gap: var(--so-space-sm);
	}
	.so-form--block .so-form__heading {
		font-family: var(--so-text-h3-family);
		font-size: var(--so-text-h3-size);
		font-weight: var(--so-text-h3-weight);
		letter-spacing: var(--so-text-h3-tracking);
		line-height: var(--so-text-h3-line-height);
	}
	.so-form--block .so-form__lead {
		font-size: inherit;
		line-height: inherit;
	}
	.so-form--block .so-form__form {
		gap: var(--so-space-md);
	}
	/* One column whatever the screen: a block is as narrow as the column it sits in. */
	.so-form--block .so-form__field:not(.so-form__field--wide) {
		grid-column: span 2;
	}
	.so-form--block .so-form__messages {
		margin-top: calc(-1 * var(--so-space-sm));
	}`;

const FORM_SOURCE = formSource('section');

/** A form's service settings, sent under `formName` to Netlify Forms. */
const sendingProps = (formName: string) =>
  P.group('Sending', {
    provider: P.choice('Form service', 'endpoint', FORM_PROVIDERS),
    endpoint: P.str('Form endpoint URL', '', { description: 'The HTTPS address your form service gives you, such as https://formspree.io/f/abc123.' }),
    accessKey: P.str('Web3Forms access key', '', { description: 'Only used with Web3Forms.' }),
    formName: P.str('Netlify form name', formName, { description: 'Only used with Netlify Forms.' })
  });

/** A form's fields, starting as `items`. */
const fieldsProp = (items: Array<Record<string, unknown>>) =>
  P.list(
    'Fields',
    'Field',
    {
      label: P.str('Label', 'Field'),
      name: P.str('Field name', '', { description: 'The name this answer is sent under. Changing the label keeps it; clear it to make a new one from the label.' }),
      type: P.choice('Type', 'text', [
        ['text', 'Short text'],
        ['email', 'Email address'],
        ['tel', 'Telephone'],
        ['textarea', 'Long text'],
        ['choice', 'Single choice'],
        ['checkbox', 'Checkbox']
      ]),
      options: P.choices('Choices', {
        description: 'Visitors see these from top to bottom. A renamed answer is still sent as its first label, so earlier answers stay together.'
      }),
      required: P.bool('Required', false),
      placeholder: P.str('Placeholder', '')
    },
    items,
    { titleField: 'label', max: 12 }
  );

// Empty, these use the site's visitor text for the page's language (Site styles > Visitor text). The button shows
// on the page, so it starts with words of its own, as the fields do; the messages only show once a message is sent.
const messageProps = (submitLabel: string) =>
  P.group('Messages', {
    submitLabel: { ...P.str('Button label', submitLabel), description: 'Empty: the send button of the site’s visitor text, in the page’s language.' },
    successMessage: { ...P.text('Sent message', ''), description: 'Empty: the sent message of the site’s visitor text, in the page’s language.' },
    errorMessage: { ...P.text('Error message', ''), description: 'Empty: the not-sent message of the site’s visitor text, in the page’s language.' }
  });

export const contactForm: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: FOUNDATION.definitionId('contact.form'),
  componentId: 'contact.form',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Contact form',
  description:
    'A real contact form that sends messages to an external form service (a Formspree-style HTTPS endpoint, Web3Forms or Netlify Forms), with spam protection and clear sent and error messages. It cannot send until it is connected to a service.',
  category: 'conversion',
  tags: ['contact', 'form', 'enquiry', 'inquiry', 'message', 'email', 'get in touch', 'formspree', 'netlify', 'web3forms'],
  icon: 'mail',
  properties: {
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', 'Contact'),
      heading: P.str('Heading', 'Send us a message'),
      lead: P.text('Supporting text', 'Tell us a little about what you need and we will reply within two working days.')
    }),
    ...sendingProps('contact'),
    fields: fieldsProp([
      { label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
      { label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
      { label: 'Phone', name: 'phone', type: 'tel', required: false, placeholder: '' },
      { label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
    ]),
    ...messageProps('Send message')
  },
  parts: { root: { nodeId: 'root', label: 'Form section' } },
  variantAxes: {
    tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: FORM_SOURCE,
  provenance: FOUNDATION.provenance('contact.form'),
  license: FOUNDATION.meta.license
};

/**
 * Signup form: the contact form as a compact block, for a newsletter or a waiting list beside other content. It asks
 * for an email address to start with, and sends to the same form services the contact form does.
 */
export const signupForm: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: FOUNDATION.definitionId('block.signup'),
  componentId: 'block.signup',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Signup form',
  description:
    'A compact signup card with a heading, a sentence and an email field, for a newsletter or a waiting list. It sends to an external form service (a Formspree-style HTTPS endpoint, Web3Forms or Netlify Forms) and cannot send until it is connected to one. A block: it goes inside a column, a grid cell or a component’s slot.',
  category: 'conversion',
  tags: ['signup', 'sign up', 'newsletter', 'subscribe', 'email', 'waiting list', 'form', 'compact', 'block'],
  icon: 'mail-plus',
  insertAs: 'element',
  properties: {
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', ''),
      heading: P.str('Heading', 'Get our newsletter'),
      lead: P.text('Supporting text', 'A short note when there is something new. No spam, and you can leave at any time.')
    }),
    ...sendingProps('newsletter'),
    fields: fieldsProp([{ label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' }]),
    ...messageProps('Sign up')
  },
  parts: { root: { nodeId: 'root', label: 'Form card' } },
  variantAxes: {
    tone: { label: 'Tone', default: 'default', options: { default: { label: 'Card' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: formSource('block'),
  provenance: FOUNDATION.provenance('block.signup'),
  license: FOUNDATION.meta.license
};

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

/** A field's settings that do nothing for its type. The editor hides them and keeps what they hold for a switch back. */
export function formFieldSettingsHidden(field: FormField): string[] {
  const type = text(field.type ?? 'text');
  return type === 'choice' ? ['placeholder'] : type === 'checkbox' ? ['placeholder', 'options'] : ['options'];
}

/** The positions of a form's single-choice questions that offer nothing to choose: the component's `unchoosable`. */
export function formUnchoosable(fields: readonly FormField[]): number[] {
  const offered = (options: unknown) => Array.isArray(options) && options.some((o) => !!o && !!text((o as { label?: unknown }).label ?? '').trim());
  return fields.flatMap((f, i) => (f?.type === 'choice' && !offered(f.options) ? [i] : []));
}

/** Whether the form refuses to send while a single-choice question has no choices. */
export function formRefusesUnchoosable(def: ComponentDefinition): boolean {
  return !!def.source?.includes(UNCHOOSABLE_SOURCE);
}
