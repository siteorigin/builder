import { FileText, Images, Layers, Newspaper, Plus } from 'lucide-react';

/** The sidebar's views, in the rail's order: the rail's buttons and the command menu's rows that open each one. */
export const LEFT_TABS = [
  { id: 'pages', label: 'Pages', icon: <FileText /> },
  { id: 'posts', label: 'Posts', icon: <Newspaper /> },
  { id: 'layers', label: 'Layers', icon: <Layers /> },
  { id: 'insert', label: 'Insert', icon: <Plus /> },
  { id: 'assets', label: 'Assets', icon: <Images /> }
] as const;
