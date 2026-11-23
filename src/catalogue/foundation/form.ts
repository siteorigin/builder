import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { P, PACK_ID, PACK_VERSION, definitionIdFor } from '../dsl';

/** Hidden "honeypot" field names each service recognises as spam traps. */
export const FORM_PROVIDERS: Array<[string, string]> = [
  ['endpoint', 'Form endpoint (Formspree, Basin, Getform…)'],
  ['web3forms', 'Web3Forms'],
  ['netlify', 'Netlify Forms']
];

const FORM_SOURCE = `<script>
	/**
	 * Contact form that sends messages to an external form service: an HTTPS form endpoint (Formspree, Basin,
	 * Getform and similar), Web3Forms or Netlify Forms. Foundation theme code component.
	 *
	 * Without JavaScript it is an ordinary form post. With JavaScript it sends in the background and reports
	 * the result in place. A hidden honeypot field catches most spam bots. Until the form is connected to a
	 * service it says so and cannot be sent: it never pretends to send.
	 */
	let {
		eyebrow = '',
		heading = '',
		lead = '',
		provider = 'endpoint',
		endpoint = '',
		accessKey = '',
		formName = 'contact',
		fields = [],
		submitLabel = 'Send message',
		successMessage = 'Thank you. Your message has been sent.',
		errorMessage = 'Sorry, your message could not be sent. Please try again or contact us directly.',
		variant = 'default',
		class: className = ''
	} = $props();

	const uid = $props.id();
	let status = $state('idle');

	const HONEYPOT = { endpoint: '_gotcha', web3forms: 'botcheck', netlify: 'bot-field' };
	// Names the services or the form itself use; a visible field never takes one of them.
	const RESERVED = ['_gotcha', 'botcheck', 'bot-field', 'form-name', 'access_key', 'subject', 'from_name', 'redirect'];
	const AUTOCOMPLETE = { email: 'email', tel: 'tel' };
	const honeypot = $derived(HONEYPOT[provider] ?? '_gotcha');
	const key = $derived(String(accessKey ?? '').trim());
	const netlifyName = $derived(String(formName ?? '').trim());
	const action = $derived(provider === 'web3forms' ? 'https://api.web3forms.com/submit' : provider === 'endpoint' && isEndpoint(endpoint) ? endpoint.trim() : undefined);
	const ready = $derived(provider === 'netlify' ? !!netlifyName : provider === 'web3forms' ? !!key : !!action);

	function isEndpoint(value) {
		try {
			const url = new URL(String(value ?? '').trim());
			return url.protocol === 'https:' && !!url.hostname;
		} catch {
			return false;
		}
	}

	function fieldName(field, i) {
		const slug = String(field.name || field.label || '')
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, '-')
			.replace(/^-+|-+$/g, '');
		const name = slug || 'field-' + (i + 1);
		return RESERVED.includes(name) ? name + '-field' : name;
	}

	async function submit(event) {
		event.preventDefault();
		if (!ready || status === 'sending') return;
		const form = event.currentTarget;
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

<section class={['so-form', 'so-form--' + variant, className]}>
	<div class="so-form__inner">
		{#if eyebrow || heading || lead}
			<div class="so-form__intro">
				{#if eyebrow}<p class="so-form__eyebrow">{eyebrow}</p>{/if}
				{#if heading}<h2 class="so-form__heading" id={uid + '-heading'}>{heading}</h2>{/if}
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
			onsubmit={submit}
		>
			{#if provider === 'netlify'}<input type="hidden" name="form-name" value={netlifyName} />{/if}
			{#if provider === 'web3forms'}<input type="hidden" name="access_key" value={key} />{/if}
			{#each fields as field, i (field.id)}
				<div class={['so-form__field', field.type === 'textarea' && 'so-form__field--wide']}>
					<label for={uid + '-' + i}>
						{field.label}{#if field.required}<span class="so-form__required" aria-hidden="true">*</span>{/if}
					</label>
					{#if field.type === 'textarea'}
						<textarea id={uid + '-' + i} name={fieldName(field, i)} required={field.required} rows="5" placeholder={field.placeholder || undefined}></textarea>
					{:else}
						<input
							id={uid + '-' + i}
							type={field.type === 'email' || field.type === 'tel' ? field.type : 'text'}
							name={fieldName(field, i)}
							required={field.required}
							autocomplete={AUTOCOMPLETE[field.type] ?? (fieldName(field, i) === 'name' ? 'name' : undefined)}
							placeholder={field.placeholder || undefined}
						/>
					{/if}
				</div>
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
					{status === 'sending' ? 'Sending…' : submitLabel}
				</button>
			</div>
		</form>
		<!-- Live regions stay in the page, outside the busy form, so their changes are announced. -->
		<div class="so-form__messages">
			<p class="so-form__status" role="status">
				{#if !ready}This form is not connected to a form service yet, so it cannot be sent.{:else if status === 'sending'}Sending your message…{:else if status === 'sent'}{successMessage}{/if}
			</p>
			<p class="so-form__status so-form__status--error" role="alert">
				{#if status === 'error'}{errorMessage}{/if}
			</p>
		</div>
	</div>
</section>

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
	.so-form__field input,
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
	.so-form__field input:focus-visible,
	.so-form__field textarea:focus-visible {
		outline: 2px solid var(--so-color-focus);
		outline-offset: 1px;
	}
	.so-form__trap {
		position: absolute;
		left: -10000px;
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
	}
</style>
`;

export const contactForm: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: definitionIdFor('contact.form'),
  componentId: 'contact.form',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Contact form',
  description:
    'A real contact form that sends messages to an external form service (a Formspree-style HTTPS endpoint, Web3Forms or Netlify Forms), with spam protection and clear sent and error messages. It cannot send until it is connected to a service.',
  category: 'conversion',
  tags: ['contact', 'form', 'enquiry', 'message', 'email', 'get in touch', 'formspree', 'netlify', 'web3forms'],
  icon: 'mail',
  properties: {
    eyebrow: P.str('Eyebrow', 'Contact'),
    heading: P.str('Heading', 'Send us a message'),
    lead: P.text('Supporting text', 'Tell us a little about what you need and we will reply within two working days.'),
    provider: P.choice('Form service', 'endpoint', FORM_PROVIDERS),
    endpoint: P.str('Form endpoint URL', '', { description: 'The HTTPS address your form service gives you, such as https://formspree.io/f/abc123.' }),
    accessKey: P.str('Web3Forms access key', '', { description: 'Only used with Web3Forms.' }),
    formName: P.str('Netlify form name', 'contact', { description: 'Only used with Netlify Forms.' }),
    fields: P.list(
      'Fields',
      'Field',
      {
        label: P.str('Label', 'Field'),
        name: P.str('Field name', '', { description: 'Sent to the form service. Leave empty to use the label.' }),
        type: P.choice('Type', 'text', [
          ['text', 'Short text'],
          ['email', 'Email address'],
          ['tel', 'Telephone'],
          ['textarea', 'Long text']
        ]),
        required: P.bool('Required', false),
        placeholder: P.str('Placeholder', '')
      },
      [
        { label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
        { label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
        { label: 'Phone', name: 'phone', type: 'tel', required: false, placeholder: '' },
        { label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
      ],
      { titleField: 'label', max: 12 }
    ),
    submitLabel: P.str('Button label', 'Send message'),
    successMessage: P.text('Sent message', 'Thank you. Your message has been sent.'),
    errorMessage: P.text('Error message', 'Sorry, your message could not be sent. Please try again or contact us directly.')
  },
  parts: { root: { nodeId: 'root', label: 'Form section' } },
  variantAxes: {
    tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: FORM_SOURCE,
  provenance: { pack: PACK_ID, packVersion: PACK_VERSION, componentId: 'contact.form' },
  license: 'GPL-3.0-or-later'
};

/** Whether a contact form instance has what it needs to send. Mirrors the component's own `ready`. */
export function formConnected(props: Record<string, unknown>): boolean {
  const provider = String(props.provider ?? 'endpoint');
  if (provider === 'netlify') return !!String(props.formName ?? '').trim();
  if (provider === 'web3forms') return !!String(props.accessKey ?? '').trim();
  if (provider !== 'endpoint') return false;
  try {
    const url = new URL(String(props.endpoint ?? '').trim());
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}
