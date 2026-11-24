import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { P } from '../dsl';
import { FOUNDATION } from './pack';

/**
 * Video: one YouTube or Vimeo video in a 16:9 frame, under an optional heading. A theme code component, because
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

	let { eyebrow = '', heading = '', lead = '', title = '', url = '', variant = 'default', class: className = '' } = $props();
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
    'One YouTube or Vimeo video in a 16:9 frame that fits every screen, under an optional heading. Paste the address of a single video. Visitors see a Play button naming the video and its host; the host’s player loads from YouTube or Vimeo only when they press it. Use for a studio tour, a product demo or a talk.',
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
    tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: VIDEO_SOURCE,
  provenance: FOUNDATION.provenance('media.video'),
  license: FOUNDATION.meta.license
};
