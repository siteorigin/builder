/**
 * The starter's sample contact details the published website still shows (sampleContactMatches), as Project health
 * and the Export dialog both review them: one warning for each detail not kept on purpose, and the way to keep one,
 * which this project remembers (`keptSamples`, saved with the workspace). Project health counts them with the
 * project's own findings, so the status bar never says "No problems" over a detail the Export dialog asks about.
 */
import type { Diagnostic } from '@shared/api';
import type { ProjectState } from '@shared/types';
import type { SampleContactKind } from '@shared/sample-contact';
import { getState, saveLocal, setState } from '../store';
import { sampleContactMatches, type ContentField, type SampleContactGroup } from './find-content';

/** Remember the sample details the author keeps on purpose (or, with `keep` false, review again), for this project. */
export function keepSamples(values: string[], keep: boolean) {
  const was = getState().keptSamples;
  const next = keep ? [...new Set([...was, ...values])] : was.filter((v) => !values.includes(v));
  setState({ keptSamples: next });
  saveLocal({ keptSamples: next });
}

/** "Contact", "Contact and the shared footer": where a sample detail is, by page or shared part, in reading order. */
export function placesOf(fields: ContentField[]): string {
  const names = [...new Set(fields.map((f) => (f.owner.kind === 'shell' ? `the shared ${f.owner.id}` : f.where)))];
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "2 places on Contact and the shared footer", "Site settings", or both: where a sample detail is on the website. */
export function sampleWhere(g: SampleContactGroup): string {
  const shown = g.matches.length ? `${g.matches.length === 1 ? '1 place' : `${g.matches.length} places`} on ${placesOf(g.matches.map((m) => m.field))}` : '';
  const site = g.identity ? 'Site settings, under Published by' : '';
  return shown && site ? `${shown}, and in ${site}` : shown || `in ${site}`;
}

/** The sample detail a Project health warning is about, from its place (`sample:email`). */
export function sampleKindOf(d: Diagnostic): SampleContactKind | null {
  const kind = d.code === 'SAMPLE_CONTACT' ? d.site?.replace(/^sample:/, '') : undefined;
  return kind === 'email' || kind === 'phone' || kind === 'address' ? kind : null;
}

/** One Project health warning for each sample detail the website shows that is not kept on purpose. */
export function sampleDiagnostics(groups: readonly SampleContactGroup[], kept: readonly string[]): Diagnostic[] {
  return groups
    .filter((g) => !kept.includes(g.value))
    .map((g) => ({
      severity: 'warning',
      code: 'SAMPLE_CONTACT',
      message: `${g.label}: ${g.value} came with the starter and is still on the website (${sampleWhere(g)}), so visitors who use it reach no one. Replace it with your own, or keep it if it is meant to be there.`,
      site: `sample:${g.kind}`
    }));
}

const groupsByState = new WeakMap<ProjectState, SampleContactGroup[]>();

/** The sample details the website shows, worked out once for each state (states are never changed once made). */
export function sampleGroups(state: ProjectState): SampleContactGroup[] {
  let groups = groupsByState.get(state);
  if (!groups) groupsByState.set(state, (groups = sampleContactMatches(state)));
  return groups;
}

const NONE: Diagnostic[] = [];
let last: { state?: ProjectState; diagnostics?: readonly Diagnostic[]; kept?: readonly string[]; out: Diagnostic[] } = { out: NONE };

/**
 * Everything Project health lists and the status bar counts: the project's own findings, then the sample details not
 * kept on purpose. The same list (the very same array) while the project, its findings and the kept details are, so
 * a store selector reading it is stable.
 */
export function healthDiagnostics(state: ProjectState | undefined, diagnostics: readonly Diagnostic[] | undefined, kept: readonly string[]): Diagnostic[] {
  if (last.state === state && last.diagnostics === diagnostics && last.kept === kept) return last.out;
  const samples = state ? sampleDiagnostics(sampleGroups(state), kept) : NONE;
  const out = samples.length ? [...(diagnostics ?? NONE), ...samples] : ((diagnostics as Diagnostic[] | undefined) ?? NONE);
  last = { state, diagnostics, kept, out };
  return out;
}
