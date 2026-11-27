/** The theme's two form components, built on the form contract (shared/form-contract.ts). */
import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import {
  AMBIGUOUS_SOURCE,
  CONNECTED_SOURCE,
  FIELD_NAME_SOURCE,
  FORM_PROVIDERS,
  RESERVED_SOURCE,
  SERVICE_SOURCE,
  UNCHOOSABLE_SOURCE
} from '@shared/form-contract';
import { P } from '../dsl';
import { FOUNDATION } from './pack';

export * from '@shared/form-contract';

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
	import { tick } from 'svelte';
	import { visitorText } from '../runtime/visitor-text.js';

	let {
		eyebrow,
		heading,
		lead,
		provider = 'endpoint',
		endpoint = '',
		accessKey = '',
		formName = '${block ? 'newsletter' : 'contact'}',
		fields,
		submitLabel,
		successMessage,
		errorMessage,
		variant = 'default',
		class: className = ''
	} = $props();

	const uid = $props.id();
	let status = $state('idle');
	// What is wrong with each answer the visitor tried to send, by field position, in the browser's own words (and
	// so its language). Shown under the field until the answer is put right.
	let errors = $state({});
	let statusLine;
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

	// An answer edited after a failed check says what is still wrong with it, or nothing once it is right.
	function edited(event, i) {
		clearFeedback();
		if (!(i in errors)) return;
		const control = event.currentTarget;
		const next = Object.assign({}, errors);
		if (control.checkValidity()) delete next[i];
		else next[i] = control.validationMessage;
		errors = next;
	}

	// The browser still checks the answers when the form is sent, and reports each one it refuses with an "invalid"
	// event, all within the one attempt. Its bubble (one answer at a time, gone in a moment) is held back; instead every
	// refused answer is shown under its own field and the first is focused: one pass puts them all right. A
	// single-choice question is one answer, however many choices it has. Without scripts the bubble stays.
	let refused = null;
	function invalid(event) {
		const control = event.target;
		const i = control.dataset?.field;
		if (i === undefined) return;
		event.preventDefault();
		if (!refused) {
			clearFeedback();
			refused = { found: {}, first: control };
			queueMicrotask(async () => {
				const { found, first } = refused;
				refused = null;
				errors = found;
				// Focused once the messages are in the page, so the field is announced with what is wrong with it.
				await tick();
				first.focus();
			});
		}
		if (!(i in refused.found)) refused.found[i] = control.validationMessage;
	}

	async function submit(event) {
		event.preventDefault();
		if (!ready || status === 'sending') return;
		const form = event.currentTarget;
		// The browser found every answer acceptable; what was said of the last attempt no longer holds.
		errors = {};
		clearFeedback();
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
			status = 'sent';${block ? '' : `
			// The confirmation heads the form, out of sight of the button at its end: the focus goes to it.
			await tick();
			if (statusLine) {
				statusLine.tabIndex = -1;
				statusLine.focus();
			}`}
		} catch {
			status = 'error';
		}
	}
</script>

{#snippet alertIcon()}
	<svg class="so-form__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10 5.75v5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" /><circle cx="10" cy="13.9" r="1.1" fill="currentColor" /></svg>
{/snippet}
{#snippet sentIcon()}
	<svg class="so-form__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="m6.4 10.3 2.4 2.4 4.8-5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" /></svg>
{/snippet}
{#snippet fieldError(i)}
	{#if errors[i]}<p class="so-form__error" id={uid + '-' + i + '-error'}>{@render alertIcon()}<span>{errors[i]}</span></p>{/if}
{/snippet}

<${root} class={['so-form',${block ? " 'so-form--block'," : ''} 'so-form--' + variant, className]}>
	<div class="so-form__inner">
		{#if eyebrow || heading || lead}
			<div class="so-form__intro">
				{#if eyebrow}<p class="so-form__eyebrow">{eyebrow}</p>{/if}
				{#if heading}<${heading} class="so-form__heading" id={uid + '-heading'}>{heading}</${heading}>{/if}
				{#if lead}<p class="so-form__lead">{lead}</p>{/if}
			</div>
		{/if}
		<!-- Why the form cannot be sent, before anything is typed into it. -->
		{#if !ready}
			<p class="so-form__notice" id={uid + '-unready'}>
				{@render alertIcon()}<span>{#if !connected}{text().formNotConnected}{:else if ambiguous}{text().formDuplicateNames}{:else}{text().formNoChoices}{/if}</span>
			</p>
		{/if}
		<!-- Sent: the confirmation heads the form, where the focus goes, and stays until the next enquiry begins. -->
		<div class="so-form__messages">
			<p
				class={['so-form__status', (status === 'sending' || status === 'sent') && 'so-form__status--shown', status === 'sending' && 'so-form__status--sending', status === 'sent' && 'so-form__status--sent']}
				role="status"
				bind:this={statusLine}
			>
				{#if status === 'sending'}{${block ? 'text().formSending' : 'text().formSendingStatus'}}{:else if status === 'sent'}{@render sentIcon()}<span>{successMessage || text().formSent}</span>{/if}
			</p>
		</div>
		<form
			class="so-form__form"
			method="POST"
			action={action}
			name={provider === 'netlify' ? netlifyName : undefined}
			data-netlify={provider === 'netlify' ? 'true' : undefined}
			netlify-honeypot={provider === 'netlify' ? honeypot : undefined}
			aria-labelledby={heading ? uid + '-heading' : undefined}
			aria-describedby={ready ? undefined : uid + '-unready'}
			aria-busy={status === 'sending'}
			data-keep-draft
			oninvalidcapture={invalid}
			onsubmit={submit}
		>
			{#if provider === 'netlify'}<input type="hidden" name="form-name" value={netlifyName} />{/if}
			{#if provider === 'web3forms'}<input type="hidden" name="access_key" value={key} />{/if}
			{#each fields as field, i (field.id)}
				{#if field.type === 'choice'}
					<!-- Disabled while a message sends, as the text fields are read-only: its answers were already taken. -->
					<fieldset class="so-form__field so-form__field--wide so-form__choices"
						class:so-form__choices--invalid={!!errors[i]}
						disabled={status === 'sending'}
						aria-describedby={errors[i] ? uid + '-' + i + '-error' : undefined}
					>
						<legend class="so-form__label">
							{field.label}{#if field.required}<span class="so-form__required" aria-hidden="true">*</span>{/if}
						</legend>
						{@render fieldError(i)}
						{#each choicesOf(field) as choice (choice.key)}
							<label class="so-form__choice">
								<input
									type="radio"
									name={names[i]}
									value={choice.value}
									data-field={i}
									data-draft-field={field.id ?? i}
									data-draft-choice={choice.id || undefined}
									required={field.required}
									aria-describedby={errors[i] ? uid + '-' + i + '-error' : undefined}
									oninput={(event) => edited(event, i)}
								/>
								<span>{choice.label}</span>
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
							data-field={i}
							data-draft-field={field.id ?? i}
							required={field.required}
							disabled={status === 'sending'}
							aria-invalid={errors[i] ? 'true' : undefined}
							aria-describedby={errors[i] ? uid + '-' + i + '-error' : undefined}
							oninput={(event) => edited(event, i)}
						/>
						<label for={uid + '-' + i}>
							{field.label}{#if field.required}<span class="so-form__required" aria-hidden="true">*</span>{/if}
						</label>
						{@render fieldError(i)}
					</div>
				{:else}
					<div class={['so-form__field', field.type === 'textarea' && 'so-form__field--wide']}>
						<label class="so-form__label" for={uid + '-' + i}>
							{field.label}{#if field.required}<span class="so-form__required" aria-hidden="true">*</span>{/if}
						</label>
						{#if field.type === 'textarea'}
							<textarea
								id={uid + '-' + i}
								class="so-form__control"
								name={names[i]}
								data-field={i}
								data-draft-field={field.id ?? i}
								required={field.required}
								readonly={status === 'sending'}
								rows="5"
								placeholder={field.placeholder || undefined}
								aria-invalid={errors[i] ? 'true' : undefined}
								aria-describedby={errors[i] ? uid + '-' + i + '-error' : undefined}
								oninput={(event) => edited(event, i)}
							></textarea>
						{:else}
							<input
								id={uid + '-' + i}
								class="so-form__control"
								type={field.type === 'email' || field.type === 'tel' ? field.type : 'text'}
								name={names[i]}
								data-field={i}
								data-draft-field={field.id ?? i}
								required={field.required}
								readonly={status === 'sending'}
								autocomplete={AUTOCOMPLETE[field.type] ?? (names[i] === 'name' ? 'name' : undefined)}
								placeholder={field.placeholder || undefined}
								aria-invalid={errors[i] ? 'true' : undefined}
								aria-describedby={errors[i] ? uid + '-' + i + '-error' : undefined}
								oninput={(event) => edited(event, i)}
							/>
						{/if}
						{@render fieldError(i)}
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
		<!-- Live regions stay in the page, outside the busy form, so their changes are announced. Each takes space only
		     while it has something to say. A failure is told beside the button that sends again. -->
		<div class="so-form__messages">
			<p class={['so-form__status', 'so-form__status--error', status === 'error' && 'so-form__status--shown']} role="alert">
				{#if status === 'error'}{@render alertIcon()}<span>{errorMessage || text().formFailed}</span>{/if}
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
	/* The intro stands apart from the form; what follows the form (its messages) takes space only while it speaks. */
	.so-form__inner {
		display: flex;
		flex-direction: column;
		gap: 0;
		max-width: var(--so-container-reading);
		margin-inline: auto;
	}
	.so-form__intro {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-md);
		margin-bottom: var(--so-space-2xl);
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
		font-family: var(--so-text-lead-family);
		font-size: var(--so-text-lead-size);
		font-weight: var(--so-text-lead-weight);
		letter-spacing: var(--so-text-lead-tracking);
		line-height: var(--so-text-lead-line-height);
		color: var(--so-color-muted);
	}
	.so-form--inverse .so-form__lead {
		color: var(--so-color-on-inverse);
		opacity: 0.78;
	}
	/* The field outline: opaque, from the field's own ink. Mixed 80% into the fill it keeps 3:1 there (WCAG 1.4.11) for
	   a grey or darker text on a light fill, down to the lightest grey that is itself readable (4.5:1), and for light text
	   on a dark fill. */
	.so-form {
		--so-form-line: color-mix(in srgb, var(--so-color-text) 80%, var(--so-color-surface));
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
	/* Questions in the theme's small text, a step bolder; the answers below them in its body text. */
	.so-form__label {
		font-family: var(--so-text-small-family);
		font-size: var(--so-text-small-size);
		line-height: var(--so-text-small-line-height);
		letter-spacing: var(--so-text-small-tracking);
		font-weight: 600;
	}
	.so-form__required {
		margin-inline-start: 0.2em;
	}
	.so-form__control {
		width: 100%;
		/* The height of the theme's buttons, so a field and its button line up. */
		min-height: 46px;
		padding: 0.65em 0.85em;
		border: 1px solid var(--so-form-line);
		border-radius: var(--so-radius-sm);
		background: var(--so-color-surface);
		color: var(--so-color-text);
		font: inherit;
		transition: border-color 160ms ease, box-shadow 160ms ease;
	}
	textarea.so-form__control {
		resize: vertical;
	}
	.so-form__control:hover:not(:focus) {
		border-color: var(--so-color-text);
	}
	/* Email addresses and phone numbers are typed left to right, whichever way the page runs, and start at the side
	   the page's text does. */
	.so-form__field input:is([type='email'], [type='tel']) {
		direction: ltr;
	}
	.so-form__field:dir(rtl) input:is([type='email'], [type='tel']) {
		text-align: right;
	}
	.so-form__control:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus));
		outline-offset: 1px;
	}
	/* An answer to put right: a heavier outline beside the words that say why (never the colour alone). */
	.so-form__control[aria-invalid='true'] {
		border-color: var(--so-color-text);
		box-shadow: inset 0 0 0 1px var(--so-color-text);
	}
	.so-form__error {
		display: flex;
		align-items: flex-start;
		gap: 0.4em;
		margin: 0;
		font-family: var(--so-text-small-family);
		font-size: var(--so-text-small-size);
		line-height: var(--so-text-small-line-height);
		font-weight: 600;
	}
	.so-form__icon {
		flex: none;
		width: 1.25em;
		height: 1.25em;
		margin-top: calc((1lh - 1.25em) / 2);
	}
	.so-form__choices {
		display: flex;
		flex-direction: column;
		gap: 0;
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.so-form__choices legend {
		margin-bottom: var(--so-space-xs);
		padding: 0;
	}
	.so-form__choices .so-form__error {
		margin-bottom: var(--so-space-xs);
	}
	/* Each answer is a row at least 44px tall, the whole of it a target. */
	.so-form__choice {
		display: flex;
		align-items: center;
		gap: 0.65em;
		min-height: 44px;
		cursor: pointer;
	}
	.so-form__check {
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		column-gap: 0.65em;
		row-gap: var(--so-space-xs);
		min-height: 44px;
	}
	.so-form__check label {
		flex: 1 1 0;
		cursor: pointer;
	}
	.so-form__check .so-form__error {
		flex-basis: 100%;
	}
	/* Radio buttons and checkboxes drawn like the fields, so they keep their outline in every tone, and filled with
	   the colour of the section's buttons once chosen. */
	.so-form__choice input,
	.so-form__check input {
		appearance: none;
		flex: none;
		display: grid;
		place-content: center;
		width: 1.375rem;
		height: 1.375rem;
		margin: 0;
		border: 1px solid var(--so-form-line);
		border-radius: var(--so-radius-sm);
		background: var(--so-color-surface);
		cursor: pointer;
		transition: background-color 160ms ease, border-color 160ms ease;
	}
	.so-form__choice input {
		border-radius: 50%;
	}
	.so-form__choice input::before,
	.so-form__check input::before {
		content: '';
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		background: var(--so-surface-ink-text, var(--so-color-on-brand));
		transform: scale(0);
		transition: transform 120ms ease;
	}
	.so-form__check input::before {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 0;
		clip-path: polygon(12% 52%, 0 66%, 38% 100%, 100% 22%, 86% 8%, 37% 70%);
	}
	.so-form__choice input:checked,
	.so-form__check input:checked {
		border-color: var(--so-surface-ink, var(--so-color-brand));
		background: var(--so-surface-ink, var(--so-color-brand));
	}
	.so-form__choice input:checked::before,
	.so-form__check input:checked::before {
		transform: scale(1);
	}
	.so-form__choice:hover input:not(:checked, :disabled),
	.so-form__check:hover input:not(:checked, :disabled) {
		border-color: var(--so-color-text);
	}
	.so-form__choices--invalid input:not(:checked),
	.so-form__check input[aria-invalid='true']:not(:checked) {
		border-color: var(--so-color-text);
		box-shadow: inset 0 0 0 1px var(--so-color-text);
	}
	.so-form__choice input:focus-visible,
	.so-form__check input:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus));
		outline-offset: 2px;
	}
	/* While a message sends its answers are taken: every field stays as it was, only the pointer says so. */
	.so-form__choices:disabled .so-form__choice,
	.so-form__choices:disabled input,
	.so-form__check:has(input:disabled),
	.so-form__check input:disabled {
		cursor: default;
	}
	/* Where the system sets the colours, the browser's own controls show which answer is chosen. */
	@media (forced-colors: active) {
		.so-form__choice input,
		.so-form__check input {
			appearance: auto;
			width: 1.15em;
			height: 1.15em;
		}
		.so-form__choice input::before,
		.so-form__check input::before {
			content: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.so-form__choice input::before,
		.so-form__check input::before {
			transition: none;
		}
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
	/* A message the visitor must not miss: what stops the form, or why the last send failed. Drawn from the section's
	   own text colour, so it reads in every tone and palette, and marked with a symbol as well as a rule. */
	.so-form__notice,
	.so-form__status--error.so-form__status--shown,
	.so-form__status--sent {
		display: flex;
		align-items: flex-start;
		gap: 0.6em;
		padding: var(--so-space-sm) var(--so-space-md);
		/* An outline rather than a tint, so the words keep the full contrast of the section's own ground. */
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		border-inline-start: 3px solid currentColor;
		border-radius: var(--so-radius-sm);
	}
	.so-form__notice {
		margin: 0 0 var(--so-space-lg);
	}
	/* On paper the form cannot be sent anyway, so what stops it on screen is left out with its messages. */
	@media print {
		.so-form__notice {
			display: none;
		}
	}
	.so-form__status {
		margin: 0;
	}
	.so-form__status--shown {
		margin-top: var(--so-space-md);
	}
	/* The confirmation sits above the fields. */
	.so-form__status--sent {
		margin: 0 0 var(--so-space-lg);
	}
	/* The button says it is sending: the line is only announced. */
	.so-form__status--sending {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.so-form__status--error {
		font-weight: 600;
	}
	/* Sent: a panel of its own, at the head of the form. */
	.so-form__status--sent {
		align-items: center;
		gap: 0.75em;
		padding: var(--so-space-lg);
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		border-radius: var(--so-radius-md);
		font-family: var(--so-text-lead-family);
		font-size: var(--so-text-lead-size);
		line-height: var(--so-text-lead-line-height);
	}
	.so-form__status--sent .so-form__icon {
		width: 1.5em;
		height: 1.5em;
		margin: 0;
		color: var(--so-surface-ink, var(--so-color-brand));
	}
	.so-form__status--sent:focus {
		outline: none;
	}
	.so-form__status--sent:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus));
		outline-offset: 2px;
	}
${block ? BLOCK_CSS : ''}
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
		max-width: none;
	}
	.so-form--block .so-form__intro {
		gap: var(--so-space-sm);
		margin-bottom: var(--so-space-lg);
	}
	.so-form--block .so-form__heading {
		font-family: var(--so-text-h3-family);
		font-size: var(--so-text-h3-size);
		font-weight: var(--so-text-h3-weight);
		letter-spacing: var(--so-text-h3-tracking);
		line-height: var(--so-text-h3-line-height);
	}
	/* The card's sentence is body text, not a section's lead. */
	.so-form--block .so-form__lead {
		font-family: var(--so-text-body-family);
		font-size: var(--so-text-body-size);
		font-weight: var(--so-text-body-weight);
		letter-spacing: var(--so-text-body-tracking);
		line-height: var(--so-text-body-line-height);
	}
	.so-form--block .so-form__form {
		gap: var(--so-space-md);
	}
	/* One column whatever the screen: a block is as narrow as the column it sits in. */
	.so-form--block .so-form__field:not(.so-form__field--wide) {
		grid-column: span 2;
	}
	/* In the card the confirmation is a line, not a panel. */
	.so-form--block .so-form__status--shown {
		margin-top: var(--so-space-sm);
	}
	.so-form--block .so-form__status--sent {
		margin: 0 0 var(--so-space-md);
		align-items: flex-start;
		gap: 0.6em;
		padding: var(--so-space-sm) var(--so-space-md);
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		/* In the colour of the check, so it is not the rule that marks a problem. */
		border-inline-start: 3px solid var(--so-surface-ink, var(--so-color-brand));
		border-radius: var(--so-radius-sm);
		font-family: inherit;
		font-size: inherit;
		line-height: inherit;
	}
	.so-form--block .so-form__status--sent .so-form__icon {
		width: 1.25em;
		height: 1.25em;
		margin-top: calc((1lh - 1.25em) / 2);
	}
	.so-form--block .so-form__notice {
		margin-bottom: var(--so-space-md);
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
// A form that is not for messages (the signup card) starts its messages with words of its own too, as its heading
// does: the visitor text speaks of a message sent.
const messageProps = (submitLabel: string, successMessage = '', errorMessage = '') =>
  P.group('Messages', {
    submitLabel: { ...P.str('Button label', submitLabel), description: 'Empty: the send button of the site’s visitor text, in the page’s language.' },
    successMessage: { ...P.text('Sent message', successMessage), description: 'Empty: the sent message of the site’s visitor text, in the page’s language.' },
    errorMessage: { ...P.text('Error message', errorMessage), description: 'Empty: the not-sent message of the site’s visitor text, in the page’s language.' }
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
    tone: { label: 'Tone', prop: 'variant', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
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
    ...messageProps('Sign up', 'Thank you. You are signed up.', 'Sorry, we could not sign you up. Please try again in a moment.')
  },
  parts: { root: { nodeId: 'root', label: 'Form card' } },
  variantAxes: {
    tone: { label: 'Tone', prop: 'variant', default: 'default', options: { default: { label: 'Card' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: formSource('block'),
  provenance: FOUNDATION.provenance('block.signup'),
  license: FOUNDATION.meta.license
};
