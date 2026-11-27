import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { P } from '../dsl';
import { FOUNDATION } from './pack';

/**
 * Video: one YouTube or Vimeo video in a widescreen (16:9) frame, under an optional heading. A theme code component, because
 * the player waits for the visitor: nothing loads from the video's host until they press Play (see
 * src/generator/video.ts for the player and the addresses it reads).
 */
const VIDEO_SOURCE = `<script>
	/**
	 * Video: one YouTube or Vimeo video under an optional heading. Foundation theme code component.
	 *
	 * The player (../runtime/VideoPlayer.svelte) shows a Play button that names the video and its host, and loads
	 * the host's player only when a visitor presses it. An empty or unsupported address shows no player.
	 */
	import VideoPlayer from '../runtime/VideoPlayer.svelte';

	let { eyebrow = '', heading, lead = '', title = '', url = '', variant = 'default', class: className = '' } = $props();
	const text = (v) => (typeof v === 'string' ? v : '');
	const headingText = $derived(text(heading).trim());
</script>

<section class={['so-video-section', 'so-video-section--' + variant, className]}>
	<div class="so-video-section__inner">
		{#if eyebrow || headingText || lead}
			<div class="so-video-section__intro">
				{#if eyebrow}<p class="so-video-section__eyebrow">{eyebrow}</p>{/if}
				{#if headingText}<h2 class="so-video-section__heading">{heading}</h2>{/if}
				{#if lead}<p class="so-video-section__lead">{lead}</p>{/if}
			</div>
		{/if}
		<VideoPlayer url={text(url)} title={text(title)} />
	</div>
</section>

<style>
	.so-video-section {
		min-width: 0;
		max-width: 100%;
		padding-block: var(--so-space-section);
		padding-inline: var(--so-container-gutter);
		background: var(--so-color-background);
		color: var(--so-color-text);
	}
	.so-video-section--muted {
		background: var(--so-color-surface-alt);
	}
	.so-video-section--inverse {
		background: var(--so-color-inverse);
		color: var(--so-color-on-inverse);
	}
	.so-video-section__inner {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-2xl);
		max-width: var(--so-container-content);
		min-width: 0;
		margin-inline: auto;
	}
	.so-video-section__intro {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-md);
		max-width: 760px;
	}
	.so-video-section__eyebrow {
		font-family: var(--so-text-eyebrow-family);
		font-size: var(--so-text-eyebrow-size);
		font-weight: var(--so-text-eyebrow-weight);
		letter-spacing: var(--so-text-eyebrow-tracking);
		line-height: var(--so-text-eyebrow-line-height);
		text-transform: var(--so-text-eyebrow-transform, none);
		color: var(--so-color-brand);
	}
	.so-video-section--inverse .so-video-section__eyebrow {
		color: var(--so-color-accent);
	}
	.so-video-section__heading {
		font-family: var(--so-text-h2-family);
		font-size: var(--so-text-h2-size);
		font-weight: var(--so-text-h2-weight);
		letter-spacing: var(--so-text-h2-tracking);
		line-height: var(--so-text-h2-line-height);
	}
	.so-video-section__lead {
		font-size: var(--so-text-lead-size);
		line-height: var(--so-text-lead-line-height);
		color: var(--so-color-muted);
	}
	.so-video-section--inverse .so-video-section__lead {
		color: var(--so-color-on-inverse);
		opacity: 0.78;
	}
</style>
`;

export const video: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: FOUNDATION.definitionId('media.video'),
  componentId: 'media.video',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Video',
  description:
    'One YouTube or Vimeo video in a widescreen frame that fits every screen, under an optional heading. Paste the address of a single video. Visitors see a Play button naming the video and its host; the host’s player loads from YouTube or Vimeo only when they press it. Use for a studio tour, a product demo or a talk.',
  category: 'media',
  tags: ['video', 'youtube', 'vimeo', 'embed', 'film', 'movie', 'clip', 'player', 'watch', 'tour', 'studio tour', 'demo', 'media'],
  icon: 'video',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Take a look around'),
    lead: P.text('Supporting text', ''),
    title: P.str('Video title', '', {
      maxLength: 200,
      description: 'What the video is, such as “Tour of our studio”. Screen readers announce it, and the Play button shows it.'
    }),
    url: P.str('Video address', '', {
      maxLength: 2048,
      description: 'The address of one YouTube or Vimeo video, such as https://www.youtube.com/watch?v=… or https://vimeo.com/…. Visitors’ browsers load the player from that site when they press Play.'
    })
  },
  parts: { root: { nodeId: 'root', label: 'Video section', styleControls: ['paddingBlock', 'background', 'color', 'hidden'] } },
  variantAxes: {
    tone: { label: 'Tone', prop: 'variant', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: VIDEO_SOURCE,
  provenance: FOUNDATION.provenance('media.video'),
  license: FOUNDATION.meta.license
};

/**
 * Compact video: the same player as the Video section, in a frame that fills the width it is given, with an optional
 * caption under it. A block: no section padding and no page-width container, so it sits in a column, a Bento grid's
 * cell or a component's slot.
 */
const VIDEO_BLOCK_SOURCE = `<script>
	/**
	 * Compact video: one YouTube or Vimeo video with an optional caption, sized to its column. Foundation theme code
	 * component (a block).
	 *
	 * The player (../runtime/VideoPlayer.svelte) shows a Play button that names the video and its host, and loads
	 * the host's player only when a visitor presses it. An empty or unsupported address shows no player.
	 */
	import VideoPlayer from '../runtime/VideoPlayer.svelte';

	let { title = '', url = '', caption = '', variant = 'default', class: className = '' } = $props();
	const text = (v) => (typeof v === 'string' ? v : '');
	const captionText = $derived(text(caption).trim());
</script>

<figure class={['so-video-block', 'so-video-block--' + variant, className]}>
	<VideoPlayer url={text(url)} title={text(title)} />
	{#if captionText}<figcaption class="so-video-block__caption">{caption}</figcaption>{/if}
</figure>

<style>
	/* Plain has no background of its own: its caption takes the colour of the text around it, so it reads on a dark
	   section as on a light one, and the root's Color sets it. Card and Dark paint their own and set their text. */
	.so-video-block {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-sm);
		width: 100%;
		min-width: 0;
		max-width: 100%;
		margin: 0;
	}
	.so-video-block--card {
		padding-block: var(--so-space-md);
		padding-inline: var(--so-space-md);
		background: var(--so-color-surface);
		color: var(--so-color-text);
		border: var(--so-border-default);
		border-radius: var(--so-radius-lg);
	}
	.so-video-block--inverse {
		padding-block: var(--so-space-md);
		padding-inline: var(--so-space-md);
		background: var(--so-color-inverse);
		color: var(--so-color-on-inverse);
		border-radius: var(--so-radius-lg);
	}
	.so-video-block__caption {
		font-size: var(--so-text-small-size);
		line-height: var(--so-text-small-line-height);
		color: inherit;
		opacity: 0.78;
	}
</style>
`;

export const videoBlock: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: FOUNDATION.definitionId('block.video'),
  componentId: 'block.video',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Compact video',
  description:
    'One YouTube or Vimeo video that fills the width it is given, with an optional caption. Paste the address of a single video; the host’s player loads only when a visitor presses Play. A block: it goes inside a column, a grid cell or a component’s slot.',
  category: 'media',
  tags: ['video', 'youtube', 'vimeo', 'embed', 'clip', 'player', 'compact', 'block', 'column'],
  icon: 'square-play',
  insertAs: 'element',
  properties: {
    title: P.str('Video title', '', {
      maxLength: 200,
      description: 'What the video is, such as “Tour of our studio”. Screen readers announce it, and the Play button shows it.'
    }),
    url: P.str('Video address', '', {
      maxLength: 2048,
      description: 'The address of one YouTube or Vimeo video, such as https://www.youtube.com/watch?v=… or https://vimeo.com/…. Visitors’ browsers load the player from that site when they press Play.'
    }),
    caption: P.str('Caption', '', { maxLength: 300 })
  },
  parts: { root: { nodeId: 'root', label: 'Video', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'radius', 'hidden'] } },
  variantAxes: {
    tone: { label: 'Tone', prop: 'variant', default: 'default', options: { default: { label: 'Plain' }, card: { label: 'Card' }, inverse: { label: 'Dark' } } }
  },
  source: VIDEO_BLOCK_SOURCE,
  provenance: FOUNDATION.provenance('block.video'),
  license: FOUNDATION.meta.license
};
