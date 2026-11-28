/**
 * How the website is built and deployed (SiteDoc.deployTarget). A static website is every page prerendered into plain
 * files, which any static host serves; it cannot answer a request that needs code to run, so an API endpoint of the
 * project's own (`src/routes/**\/+server.js` or `.ts`) that is not prerendered stops its build. A Node.js server is built
 * with SvelteKit's adapter-node: its pages are prerendered all the same, and it also runs the endpoints when visitors
 * ask. The generated project's vite.config.js reads the choice from src/lib/siteorigin/paths.json at build time.
 */
import type { DeployTarget, SiteDoc } from './types';

export const DEPLOY_TARGETS: readonly DeployTarget[] = ['static', 'node'];

/** The site's deployment target: a static website unless it names a Node.js server. */
export function deployTarget(site: Pick<SiteDoc, 'deployTarget'>): DeployTarget {
  return site.deployTarget === 'node' ? 'node' : 'static';
}

/** Whether the site is built as a Node.js server. */
export const runsOnNode = (site: Pick<SiteDoc, 'deployTarget'>): boolean => deployTarget(site) === 'node';

/** Each target as Site settings names it. */
export const DEPLOY_TARGET_LABELS: Record<DeployTarget, string> = {
  static: 'Static website (any host)',
  node: 'Node.js server'
};

/** What each target delivers, as Site settings explains it. */
export const DEPLOY_TARGET_HINTS: Record<DeployTarget, string> = {
  static: 'Every page is built into plain files that any static host serves. API endpoints that need a server stop the export.',
  node: 'Builds a Node.js server (SvelteKit adapter-node) that runs your API endpoints. Pages are still prerendered. Start it with node index.js on any host that runs Node.js 22 or later.'
};

/** The command that starts an exported Node.js server, from inside its folder. */
export const NODE_START_COMMAND = 'node index.js';
