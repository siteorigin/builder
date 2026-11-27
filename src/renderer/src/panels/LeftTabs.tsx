import { FileText, Images, Layers, Library, Plus, SearchCheck } from 'lucide-react';

/** The sidebar's views, in the rail's order: the rail's buttons and the command menu's rows that open each one. */
export const LEFT_TABS = [
  { id: 'pages', label: 'Pages', icon: <FileText /> },
  // The Content workspace (#675): every collection's entries (a blog's posts, a team, projects), and the writer.
  { id: 'posts', label: 'Content', icon: <Library /> },
  { id: 'layers', label: 'Layers', icon: <Layers /> },
  { id: 'insert', label: 'Insert', icon: <Plus /> },
  { id: 'assets', label: 'Assets', icon: <Images /> },
  // The SEO view (#700): its list of the site's pages and posts here, the chosen one in the canvas's place.
  { id: 'seo', label: 'SEO', icon: <SearchCheck /> }
] as const;
