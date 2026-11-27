/**
 * A contact form whose code adaptFormSource (src/generator/webmcp.ts) reads as the theme's form: the Svelte source the
 * Builder's own copy of Foundation wrote (`src/catalogue/foundation/form.ts` before #998), on today's form contract.
 * The release's contact form is written another way, which the adapter does not yet read (see the Release gap tests in
 * webmcp.test.ts), so the tests of what WebMCP does with a form that declares a tool run on this one: the release's
 * own contact form definition, with this code in place of the release's.
 */
import type { ProjectState } from '@shared/types';
import { AMBIGUOUS_SOURCE, CONNECTED_SOURCE, FIELD_NAME_SOURCE, RESERVED_SOURCE, SERVICE_SOURCE, UNCHOOSABLE_SOURCE } from '@shared/form-contract';
import { installComponent } from '@engine/install';

/** The form's Svelte source, as a page section. */
function formSource(): string {
  const block = false;
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
		/* What is wrong, in the error colour that reads on the form's own ground: the light grounds' or dark sections'. */
		--so-form-error: var(--so-color-error);
	}
	.so-form--inverse {
		--so-form-error: var(--so-color-error-on-inverse);
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
		/* The fill stops inside the edge, so the edge is seen over the form's ground, where its contrast is measured. */
		background-clip: padding-box;
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
	/* An answer to put right: a heavier outline beside the words that say why (never the colour alone), in the error
	   colour. The outer edge meets the form's ground and the inner one the field's own fill, so each takes the error
	   colour that reads there. */
	.so-form__control[aria-invalid='true'],
	.so-form__control[aria-invalid='true']:hover {
		border-color: var(--so-form-error);
		box-shadow: inset 0 0 0 1px var(--so-color-error);
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
		color: var(--so-form-error);
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
		background-clip: padding-box;
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
	.so-form__check input[aria-invalid='true']:not(:checked),
	.so-form__choices--invalid .so-form__choice:hover input:not(:checked, :disabled),
	.so-form__check:hover input[aria-invalid='true']:not(:checked, :disabled) {
		border-color: var(--so-form-error);
		box-shadow: inset 0 0 0 1px var(--so-color-error);
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
	   own text colour (a failed send from its error colour), so it reads in every tone and palette, and marked with a
	   symbol as well as a rule. */
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
		color: var(--so-form-error);
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

</style>
`;
}

/** The contact form code the adapter takes the tool attributes into. */
export const SUPPORTED_FORM_SOURCE = formSource();

/**
 * Install the release's contact form in the project with SUPPORTED_FORM_SOURCE as its code, so every contact form the
 * project then places is one the adapter reads; returns the state.
 */
export function withSupportedForm(state: ProjectState): ProjectState {
  state.components[installComponent(state, 'contact.form')].source = SUPPORTED_FORM_SOURCE;
  return state;
}
