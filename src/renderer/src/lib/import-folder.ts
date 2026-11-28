const segments = (path: string) => (/^([A-Za-z]:)?\\|^\\\\/.test(path) ? path.split(/[\\/]/) : path.split('/')).filter(Boolean).slice(0, -1);

/**
 * The folder each file comes from, as its last two folders ("Trips/Shoreline"), the thing that tells same-named, same-sized
 * photos apart. Files that would read the same get more of their path until they differ.
 */
export function fromFolders(paths: string[]): string[] {
  const parts = paths.map(segments);
  const depth = paths.map(() => 2);
  const label = (i: number) => parts[i].slice(-depth[i]).join('/');
  for (let round = 0; round < 64; round++) {
    let grown = false;
    const seen = new Map<string, number[]>();
    paths.forEach((_, i) => seen.set(label(i), [...(seen.get(label(i)) ?? []), i]));
    for (const group of seen.values()) {
      if (group.length < 2) continue;
      for (const i of group) if (depth[i] < parts[i].length) { depth[i]++; grown = true; }
    }
    if (!grown) break;
  }
  return paths.map((_, i) => label(i));
}
