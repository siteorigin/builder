/** What the Insert preview's placement map says: a caption naming where the new thing lands, then the neighbour
 *  before it, the new row, and the neighbour after it. Plain data so the preview draws a picture, not controls. */
export type PlacementNeighbours = {
  owner: string;
  before: string | null;
  after: string | null;
};
export type PlacementRow = { kind: "context" | "new"; label: string };

export function placementMap(
  map: PlacementNeighbours,
  newName: string,
): { caption: string; rows: PlacementRow[] } {
  return {
    caption: `Where it goes on ${map.owner}`,
    rows: [
      { kind: "context", label: map.before ?? `Top of ${map.owner}` },
      { kind: "new", label: newName },
      { kind: "context", label: map.after ?? `End of ${map.owner}` },
    ],
  };
}
