import {
  AlignHorizontalSpaceAround, BadgeInfo, BookImage, Box, ChartLine, ChartNoAxesColumn, CircleQuestionMark, Columns2,
  Columns3, Component, Contact, Diamond, FileText, GalleryHorizontal, GalleryHorizontalEnd, Heading1, Image, Images,
  LayoutDashboard, LayoutGrid, LayoutList, LayoutPanelLeft, LayoutPanelTop, LayoutTemplate, List, ListOrdered, Mail,
  MailPlus, Megaphone, MessageSquareQuote, Newspaper, PanelBottom, PanelLeft, PanelRight, PanelTop, Pilcrow, Quote,
  RectangleHorizontal, Rows3, Search, SeparatorHorizontal, SquareDashed, SquarePlay, SquareStar, Star, Tag,
  TextAlignCenter, ToggleRight, TriangleRight, Type, Users, Video, WavesHorizontal, type LucideIcon as Icon
} from 'lucide-react';

/**
 * The icons Insert, Quick insert, the command menu and the change-design dialog show beside what can be inserted, by
 * the name a component's definition gives it (`ComponentDefinition.icon`, a Lucide name such as `layout-grid`) or the
 * app gives its own entries. Only these icons are in the app, not Lucide's whole set (#958): every name the shipped theme packs and the
 * app's own entries use is here (tests/unit/insert-icons.test.ts holds that), and any other name shows a box, as a name
 * Lucide has no icon for always has.
 */
const INSERT_ICONS: Record<string, Icon> = {
  AlignHorizontalSpaceAround, BadgeInfo, BookImage, Box, ChartLine, ChartNoAxesColumn, CircleQuestionMark, Columns2,
  Columns3, Component, Contact, Diamond, FileText, GalleryHorizontal, GalleryHorizontalEnd, Heading1, Image, Images,
  LayoutDashboard, LayoutGrid, LayoutList, LayoutPanelLeft, LayoutPanelTop, LayoutTemplate, List, ListOrdered, Mail,
  MailPlus, Megaphone, MessageSquareQuote, Newspaper, PanelBottom, PanelLeft, PanelRight, PanelTop, Pilcrow, Quote,
  RectangleHorizontal, Rows3, Search, SeparatorHorizontal, SquareDashed, SquarePlay, SquareStar, Star, Tag,
  TextAlignCenter, ToggleRight, TriangleRight, Type, Users, Video, WavesHorizontal
};

/** The icon a name shows: `layout-grid` (or `LayoutGrid`) is Lucide's LayoutGrid; a name not in the set is a box. */
export function insertIcon(name: string | undefined): Icon {
  const key = (name ?? 'box')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join('');
  return Object.hasOwn(INSERT_ICONS, key) ? INSERT_ICONS[key] : Box;
}

export function LucideIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const I = insertIcon(name);
  return <I size={size} />;
}
