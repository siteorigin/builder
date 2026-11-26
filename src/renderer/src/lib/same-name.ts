import type { AssetRecord } from '@shared/types';
import { formatBytes, plural } from './storage';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The day an image was added, as an author reads it, or '' when its record has no readable time. */
function addedOn(a: AssetRecord): string {
  const t = typeof a.createdAt === 'string' ? Date.parse(a.createdAt) : NaN;
  return Number.isNaN(t) ? '' : `added ${DAY.format(t)}`;
}

/**
 * What tells apart images that share a name ("hero"), by the things an author sees: each one's file size, the day it
 * was added, and how many places use it. Only the facts that differ within a group are named; images alike in all
 * of them are numbered in the order they were added ("image 2 of 3"). The asset ID stays out of it: it means
 * nothing to an author. `key` is the name as compared (see the Assets panel); images without a name of their own
 * are never grouped.
 */
export function sameNameLabels(images: AssetRecord[], usage: Record<string, number>, key: (a: AssetRecord) => string): Map<string, string> {
  const groups = new Map<string, AssetRecord[]>();
  for (const a of images) {
    if (typeof a.name !== 'string') continue;
    const k = key(a);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const facts = group.map((a) => {
      const used = usage[a.id] ?? 0;
      return [formatBytes(a.bytes), addedOn(a), used ? `used in ${plural(used, 'place', 'places')}` : 'not used'];
    });
    const telling = facts[0].map((_, i) => i).filter((i) => new Set(facts.map((f) => f[i])).size > 1);
    const labels = facts.map((f) => telling.map((i) => f[i]).filter(Boolean).join(' · '));
    const order = [...group].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    group.forEach((a, i) => {
      const alike = labels.filter((l) => l === labels[i]).length > 1;
      const numbered = `image ${order.indexOf(a) + 1} of ${group.length}`;
      out.set(a.id, alike ? [labels[i], numbered].filter(Boolean).join(' · ') : labels[i]);
    });
  }
  return out;
}
