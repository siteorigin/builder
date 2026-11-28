import type { NearbyProject } from '@shared/api';
import type { Toast } from '../store';

/**
 * The notice's action for a project beside a chosen folder that is not one (#1433): Open, naming the project. Offered
 * over an open project (`opening`, its workspace), it is withdrawn once another has taken that one's place.
 */
export function nearbyOffer(nearby: NearbyProject | undefined, open: (dir: string) => void, opening?: string): Toast['action'] {
  if (!nearby) return undefined;
  return { label: `Open ${nearby.name}`, run: () => open(nearby.dir), ...(opening === undefined ? {} : { opening }) };
}
