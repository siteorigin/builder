import type { NearbyProject } from '@shared/api';
import type { Toast } from '../store';

/** The notice's action for a project beside a chosen folder that is not one (#1433): Open, naming the project. */
export function nearbyOffer(nearby: NearbyProject | undefined, open: (dir: string) => void): Toast['action'] {
  return nearby ? { label: `Open ${nearby.name}`, run: () => open(nearby.dir) } : undefined;
}
