/**
 * What a person can do in Builder, one row per user intent (issue #498): where they start, the discoverable actions that
 * get them there, what proves it happened, the scenario it is proven in, where it applies, the tests that prove it, and
 * what is still missing, with its owner.
 *
 * `tests/unit/interaction-coverage.test.ts` holds this list to the app: every action the readers in surfaces.ts find
 * (the application and writing menus, the command menu, the sidebar's views, the editor's shortcuts, every menu the
 * editor draws) is a route of some row, every route of those kinds still exists, every e2e script is linked from a row,
 * and every linked test and named step is there. A change that adds an interaction adds or extends its row here, with a
 * proof or an owned gap (CONTRIBUTING.md, "Interaction coverage").
 *
 * `node tests/coverage/interactions.ts --markdown` prints the list as tables, one per area.
 */
import { pathToFileURL } from 'node:url';
import type { Platform } from './surfaces.ts';

export type Area =
  | 'projects'
  | 'pages'
  | 'layers'
  | 'inspector'
  | 'styles'
  | 'insert'
  | 'components'
  | 'code'
  | 'assets'
  | 'find'
  | 'history'
  | 'preview'
  | 'export'
  | 'assistant'
  | 'posts'
  | 'settings'
  | 'desktop';

/** The areas, in the order the tables are printed. */
export const AREAS: Record<Area, string> = {
  projects: 'Projects: create, open, duplicate, trust, recover, close',
  pages: 'Pages, navigation and SEO',
  layers: 'Layers, selection, multi-select, clipboard and drag',
  inspector: 'Inspector content, breakpoints and states',
  styles: 'Site styles, tokens, fonts and themes',
  insert: 'Insert and canvas building',
  components: 'Component authoring and Component Studio',
  code: 'Code mode and diagnostics',
  assets: 'Assets, fonts and import',
  find: 'Search and replace',
  history: 'History, versions, conflicts and read-only',
  preview: 'Editor and visitor preview',
  export: 'Export, errors and reopening',
  assistant: 'AI conversations, attachments, edits and approvals',
  posts: 'Collections and posts',
  settings: 'Settings and editor layout',
  desktop: 'Desktop menus, choosers and text editing'
};

/**
 * How a test proves a row: `driver` drives the public test driver (tests/driver) as a client would; `e2e` drives the
 * built app with Playwright directly (tests/e2e/harness.mjs); `unit` tests a lower layer; `packaged` runs the packaged
 * app (`npm run pack`); `design` only captures screens.
 */
export type ProofKind = 'driver' | 'e2e' | 'unit' | 'packaged' | 'design';

export interface Proof {
  /** The test file, from the repository root. */
  test: string;
  kind: ProofKind;
  /** A `step('…')` (or `it('…')`) text the test has, naming where it proves this row. */
  step?: string;
}

/** What is not proven yet, and who owns it: an open issue when there is one, else the area that should take it. */
export interface Gap {
  missing: string;
  owner: string;
  issue?: number;
}

export interface Interaction {
  /** Stable, `area.what`. */
  id: string;
  area: Area;
  /** What the person wants to do, in their words. */
  intent: string;
  /** The state it starts from. */
  start: string;
  /**
   * The discoverable actions that do it. Keys from surfaces.ts (`menu:`, `role:`, `writing:`, `command:`, `tab:`,
   * `key:`, `item:`) are checked against the app; the rest name a control where a person finds it: `welcome:`,
   * `toolbar:`, `panel:`, `inspector:`, `canvas:`, `preview:`, `chat:`, `dialog:`, `status:`.
   */
  routes: string[];
  /** What a test checks to say it happened: on screen, in the saved project, in an export. */
  outcome: string;
  /** The fixture and provider it is proven with (`welcome · scripted`, `business-v1 · none`, ...). */
  scenario: string;
  /** The platforms it applies to (default: all three). */
  platforms?: Platform[];
  /** The builds a test proves it on (default: the unpacked build the e2e scripts launch). */
  builds?: ('dev' | 'packaged')[];
  proof: Proof[];
  gaps?: Gap[];
}

/** Open issues that own gaps, by number: the work that will close them. */
export const GAP_ISSUES: Record<number, string> = {
  130: 'Run the live provider checks',
  346: 'Build rich visual components, local-model tools and site collections',
  489: 'Let external AI testers drive and verify the whole Builder app',
  672: 'Build optional flat-file CMS, collection loops, and read-only external API sources',
  699: 'Move SEO previews into a dedicated SEO view'
};

const J = 'tests/e2e/journeys.mjs';
const L_SHARE = 'tests/e2e/live-share.mjs';
const L_COLLAB = 'tests/e2e/live-collaborator.mjs';
const L_VIEWER = 'tests/e2e/live-viewer.mjs';
const L_RECOVER = 'tests/e2e/live-recovery.mjs';

export const INTERACTIONS: Interaction[] = [
  {
    id: 'journey.principal',
    area: 'projects',
    intent: 'Start from nothing, make a site, change it, talk it through with the assistant, export it and come back to it',
    start: 'Welcome in a fresh profile, scripted assistant',
    routes: ['welcome:New project', 'dialog:New project › Create project', 'tab:layers', 'inspector:Heading', 'chat:Message', 'toolbar:Undo', 'toolbar:Redo', 'menu:File > Export…', 'menu:File > Close Project', 'menu:File > Open Project…'],
    outcome: 'The edit and the approved AI change are in the home page document and the preview; Undo and Redo move only the AI change; the exported index.html holds both; the reopened project still does; the whole run replays from its record in a fresh session',
    scenario: 'welcome · scripted',
    proof: [
      { test: J, kind: 'driver', step: 'principal journey: a new site from Welcome, through the New project dialog' },
      { test: J, kind: 'driver', step: 'principal journey: Undo takes back the assistant’s change and Redo makes it again, leaving the heading' },
      { test: J, kind: 'driver', step: 'the record proves the principal journey' },
      { test: J, kind: 'driver', step: 'the recorded journey replays in a fresh session' },
      { test: 'scripts/model-smoke.mjs', kind: 'driver' }
    ]
  },
  {
    id: 'journey.cancelled',
    area: 'projects',
    intent: 'Change my mind: cancel opening a project, and say no to the assistant changing more than I asked',
    start: 'Welcome, then a project with the hero selected',
    routes: ['welcome:Open project', 'menu:File > Open Project…', 'chat:No, only change the selection'],
    outcome: 'A cancelled chooser leaves Welcome as it was with no project opened; a declined wider change leaves the site name as it was',
    scenario: 'welcome · scripted',
    proof: [
      { test: J, kind: 'driver', step: 'cancelled journey: an Open Project chooser cancelled from Welcome opens nothing' },
      { test: J, kind: 'driver', step: 'cancelled journey: an edit that needs more than the selection is declined, and the site keeps its name' }
    ]
  },
  // ---- projects ----
  {
    id: 'projects.create',
    area: 'projects',
    intent: 'Make a new site, choosing its theme and starter content',
    start: 'Welcome in a fresh profile, or a project already open',
    routes: ['welcome:New project', 'dialog:New project › Theme', 'dialog:New project › Starter', 'dialog:New project › Create project', 'dialog:New project › Escape', 'menu:File > New Project…', 'command:newproject', 'item:Toolbar:New project…'],
    outcome: 'The project is written to the folder the chooser gave and opens in the editor; a Blank site’s Home starts empty with a note only the editor shows; over an open project the focused field is saved first, and Escape makes nothing and leaves the project as it was',
    scenario: 'welcome · none',
    proof: [
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'Welcome: a dialog opens from its button, keeps the focus, and Escape closes it with nothing made' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'the dialog again: name, starter and folder chosen through its controls, and the project created' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'a project is created from Welcome in a folder chosen in the native chooser' },
      { test: 'tests/e2e/mcp.mjs', kind: 'driver', step: 'open New project, fill its name and read it back' },
      { test: 'tests/e2e/smoke.mjs', kind: 'e2e', step: 'create a project' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Welcome: Export and Close Project are unavailable, New Project opens its dialog' },
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'Blank: Home starts empty, and only the editor says how to begin' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'name, starter and folder chosen through its controls' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'File > New Project opens over the project, saving the focused field, and Escape leaves the project as it was' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'New Project asks over it and keeps it open (#80)' }
    ],
    gaps: [{ missing: 'New project… from the command menu and from the toolbar’s project menu is never chosen by a test', owner: 'projects' }]
  },
  {
    id: 'projects.packaged',
    area: 'projects',
    intent: 'Make and preview a site in the installed app, on a computer with no Node',
    start: 'The packaged app at Welcome, with no system Node on PATH',
    routes: ['welcome:New project'],
    outcome: 'Welcome is served from app://editor under its content security policy; a Business project is created and its preview shows the home page heading',
    scenario: 'Business starter · none',
    builds: ['dev', 'packaged'],
    proof: [
      { test: 'tests/e2e/packaged.mjs', kind: 'packaged' },
      { test: 'tests/e2e/linux-container.mjs', kind: 'packaged' },
      { test: 'tests/e2e/smoke.mjs', kind: 'e2e', step: 'create a project' }
    ],
    gaps: [
      { missing: 'The packaged runs create the project through the project API, not through the New project dialog', owner: 'projects' },
      { missing: 'Packaged runs on Windows and Linux: linux-container.mjs needs a Linux container and local stabilization runs on macOS only', owner: 'desktop' }
    ]
  },
  {
    id: 'projects.open',
    area: 'projects',
    intent: 'Open a project I made before',
    start: 'Welcome, or another project open',
    routes: ['welcome:Open project', 'menu:File > Open Project…', 'command:openproject', 'item:Toolbar:Open project…'],
    outcome: 'The chosen folder opens in the same window, replacing an open project only once it has opened; a cancelled chooser opens nothing and keeps what was open',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Welcome: Open Project shows the folder picker over the window and opens the chosen project' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'a project: Open Project switches to the chosen project' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'cancel is an answer: Open project… on Welcome and in the File menu is closed without a choice' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'switching to another project saves the focused field first' },
      { test: 'tests/unit/open-project.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Open project… from the command menu and from the toolbar’s project menu is never chosen by a test', owner: 'projects' }]
  },
  {
    id: 'projects.open-folder',
    area: 'projects',
    intent: 'Open a project by its folder where the file picker cannot choose folders',
    start: 'Welcome or a project, on Windows or Linux',
    routes: ['menu:File > Open Project Folder…'],
    outcome: 'Asked for a folder, the controller offers the chooser a folder (on Windows and Linux too); what opening a chosen folder does is not checked here',
    scenario: 'unit fixtures · none',
    platforms: ['win32', 'linux'],
    proof: [{ test: 'tests/unit/open-project.test.ts', kind: 'unit', step: 'chooses a folder when asked to, on Windows and Linux too' }],
    gaps: [{ missing: 'No e2e script chooses File > Open Project Folder…; local runs are macOS only, where the item does not exist', owner: 'desktop' }]
  },
  {
    id: 'projects.open-zip',
    area: 'projects',
    intent: 'Open a project someone sent me as a ZIP file',
    start: 'Welcome, with an editable project ZIP exported from another copy',
    routes: ['welcome:Open project', 'menu:File > Open Project…', 'dialog:Choose where the working copy goes'],
    outcome: 'The ZIP unpacks into a new folder where the recipient chose, asks for trust and opens with its pages and media; a second open makes a second copy; cancelling while it unpacks leaves nothing; a website ZIP is explained instead',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/open-zip.mjs', kind: 'e2e', step: 'the recipient opens the ZIP file from Welcome, chooses where it goes, and trusts it' },
      { test: 'tests/e2e/open-zip.mjs', kind: 'e2e', step: 'opening the same ZIP file again makes a second copy and leaves the first as it is' },
      { test: 'tests/e2e/open-zip.mjs', kind: 'e2e', step: 'cancelling while it unpacks leaves nothing behind' },
      { test: 'tests/e2e/open-zip.mjs', kind: 'e2e', step: 'a website ZIP is explained, with how to ask for the editable version' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'File > Open Project… opens the ZIP file into a chosen folder' },
      { test: 'tests/unit/open-project.test.ts', kind: 'unit', step: 'unpacks an editable project ZIP into a new folder where the recipient chooses, then asks for trust' },
      { test: 'tests/unit/unzip.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'projects.trust',
    area: 'projects',
    intent: 'Decide whether to trust a project I was given',
    start: 'A project from elsewhere chosen in Open project, with or without another project open',
    routes: ['dialog:Trust this project? › Trust', 'dialog:Trust this project? › Cancel'],
    outcome: 'Declined, the project is not opened and the open project or Welcome stays as it was; trusted, it opens',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'its trust is declined, and the project open stays' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'opened again from its manifest, the copy is trusted and opens' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'a project that needs trust is asked about over the open project, and Cancel leaves it as it was' },
      { test: 'tests/e2e/find-moved-project.mjs', kind: 'e2e', step: 'the moved folder asks for trust; Cancel keeps the card' },
      { test: 'tests/unit/open-project.test.ts', kind: 'unit', step: 'still asks for trust on a healthy manifest, naming the project' }
    ]
  },
  {
    id: 'projects.recent',
    area: 'projects',
    intent: 'Go back to a recent project, with the clients I work for every month kept at the top',
    start: 'Welcome with more than twenty recent projects',
    routes: ['welcome:Recent projects › card', 'welcome:Recent projects › Filter', 'welcome:Recent projects › Pin', 'welcome:Recent projects › Unpin'],
    outcome: 'Cards name each project by its site name and its own folder and follow a rename; the filter finds projects by name or folder; pinned projects stay above the twenty newest, never rotate off, keep their place when opened again, and go back among the rest when unpinned',
    scenario: 'Blank and Business starters · none',
    proof: [
      { test: 'tests/e2e/site-rename.mjs', kind: 'e2e', step: 'Recent projects lists the new name after switching straight into another project, and after closing to Welcome' },
      { test: 'tests/e2e/pinned-projects.mjs', kind: 'e2e', step: 'the two Mill Roads are told apart by their own folders' },
      { test: 'tests/e2e/pinned-projects.mjs', kind: 'e2e', step: 'the filter finds projects by name or folder in both groups' },
      { test: 'tests/unit/recent-places.test.ts', kind: 'unit' },
      { test: 'tests/e2e/pinned-projects.mjs', kind: 'e2e', step: 'Longstanding client is created, closed, and pinned from its card' },
      { test: 'tests/e2e/pinned-projects.mjs', kind: 'e2e', step: 'one more client is created: the oldest unpinned project rotates off, the pinned ones stay' },
      { test: 'tests/e2e/pinned-projects.mjs', kind: 'e2e', step: 'unpinned, Longstanding client goes back among the rest, newest first' },
      { test: 'tests/unit/pinned-recents.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'projects.find-moved',
    area: 'projects',
    intent: 'Find a project whose folder I moved, or take a gone one off the list',
    start: 'Welcome with a card whose folder has moved',
    routes: ['welcome:Recent projects › Find folder…', 'welcome:Recent projects › Remove'],
    outcome: 'The card says the folder is not found with its old path; Find folder… on the moved folder leaves the project listed once; a cancelled picker, another project of the same name or a cancelled trust keep the card; Remove takes a gone one off',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/find-moved-project.mjs', kind: 'e2e', step: 'Find folder… on the missing card, choosing the moved folder, leaves Mill Road listed once' },
      { test: 'tests/e2e/find-moved-project.mjs', kind: 'e2e', step: 'cancelling the picker keeps the card' },
      { test: 'tests/e2e/find-moved-project.mjs', kind: 'e2e', step: 'after a restart the list is the same' },
      { test: 'tests/unit/find-moved-project.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'projects.duplicate',
    area: 'projects',
    intent: 'Make a copy of a project to try something without touching the original',
    start: 'Blank site open',
    routes: ['item:Toolbar:Duplicate project…', 'dialog:Duplicate project › Open copy'],
    outcome: 'A folder that cannot take the copy is explained and nothing is written; the original stays open until Open copy; changes in the copy stay in the copy; Recent projects tells the two apart',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/duplicate.mjs', kind: 'e2e', step: 'another folder takes the copy, and the original stays open until Open copy' },
      { test: 'tests/e2e/duplicate.mjs', kind: 'e2e', step: 'a change made in the copy lands in the copy' },
      { test: 'tests/e2e/duplicate.mjs', kind: 'e2e', step: 'Recent projects tells the two apart' },
      { test: 'tests/unit/duplicate-project.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'projects.close',
    area: 'projects',
    intent: 'Close the project and go back to Welcome',
    start: 'Business site open, an Inspector field focused',
    routes: ['menu:File > Close Project', 'command:close', 'item:Toolbar:Close project', 'toolbar:All projects'],
    outcome: 'Welcome shows in the same window; the field being typed in is on disk first; Export and Close Project are withdrawn from the File menu',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'File > Close Project returns to Welcome in the same window' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'File > Close Project saves the focused Inspector field' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'the toolbar mark, pressed from the keyboard or clicked, saves the focused field and lands on Welcome (#517)' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'a project: Export and Close Project become available and act' },
      { test: 'tests/e2e/project-footprint.mjs', kind: 'e2e', step: 'memory at Welcome stays near a fresh launch’s and does not grow with each close' }
    ],
    gaps: [{ missing: 'Close project from the command menu and from the toolbar’s project menu is never chosen by a test', owner: 'projects' }]
  },
  {
    id: 'projects.save',
    area: 'projects',
    intent: 'Never lose what I was typing, whether I save or leave',
    start: 'Business site open, typing in an Inspector or Site details field',
    routes: ['key:s', 'status:Saved', 'dialog:Keep editing', 'dialog:Leave without it', 'toolbar:All projects', 'menu:File > Close Project'],
    outcome: 'Cmd/Ctrl+S commits the focused field to disk and the status says Saved only past the revision the edit started at; leaving with a value the field refuses asks first and names it; Keep editing returns focus to it with the project open; Leave without it closes with the saved value untouched',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'Cmd+S in a focused Search title saves it (the explicit save the lifecycle actions now share)' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'the saved status is not announced over an unsaved change' },
      { test: 'tests/e2e/outcomes.mjs', kind: 'driver', step: 'a visible edit is saved: the editor says Saved past the revision it started at, and the document on disk holds it' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'an invalid draft asks before leaving, and Keep editing returns to it' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'closing the window or quitting with an invalid draft asks too' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'Leave without it discards the invalid draft' },
      { test: 'tests/e2e/site-details.mjs', kind: 'e2e', step: 'leaving the project with a refused draft asks first' },
      { test: 'tests/e2e/text-limits.mjs', kind: 'e2e', step: 'leaving with a refused description asks, names it' },
      { test: 'tests/unit/leave-gate.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'projects.recover',
    area: 'projects',
    intent: 'Get a damaged or crashed project back',
    start: 'A project with a truncated document, or one being edited when the editor page or the app goes down',
    routes: ['welcome:Open project', 'menu:File > Open Project…', 'welcome:Recent projects › card'],
    outcome: 'A damaged file is named and an open project stays as it was, and the project opens once repaired; a save that fails part way leaves the documents whole; a crashed editor page is loaded again for the File command chosen, which it then carries out',
    scenario: 'Business starter · none; unit fixtures',
    proof: [
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'a damaged project names its file and leaves the open project as it was; repaired, it opens' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'from Welcome too: a damaged project names its file, and opens once repaired' },
      { test: 'tests/unit/open-project.test.ts', kind: 'unit', step: 'reports a truncated manifest by file and folder' },
      { test: 'tests/unit/crash-durability.test.ts', kind: 'unit' },
      { test: 'tests/unit/session-recovery.test.ts', kind: 'unit' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'a crashed editor is loaded again for a File command, which it then carries out' }
    ],
    gaps: [{ missing: 'No e2e script kills the app during a save and reopens the project to find the work there', owner: 'projects' }]
  },
  {
    id: 'projects.reload-editor',
    area: 'projects',
    intent: 'Get back to the editor after it crashed or failed',
    start: 'A project open when the editor page crashes, a screen fails while rendering, or the main process meets an error nothing caught',
    routes: ['dialog:The editor stopped working › Reload Editor', 'dialog:The editor stopped working › Reload editor', 'dialog:The editor stopped working › Close project'],
    outcome:
      'A crashed editor asks over its window to be loaded again, and Reload Editor brings back the same opening of the project; a screen that fails while rendering says so and reloads, or closes the project; an uncaught main-process error is reported in the app’s own words and the app keeps running',
    scenario: 'Business starter · none; browser and unit fixtures',
    proof: [
      { test: 'tests/e2e/crash-recovery.mjs', kind: 'e2e', step: 'a crashed editor asks to be loaded again, and Reload Editor brings back the same project' },
      { test: 'tests/e2e/crash-recovery.mjs', kind: 'e2e', step: 'an error the main process did not catch is reported in the app’s own words, and the editor keeps working' },
      { test: 'tests/unit/editor-recovery.test.ts', kind: 'unit' },
      { test: 'tests/unit/main-errors.test.ts', kind: 'unit' },
      { test: 'tests/unit/render-failure-browser.test.ts', kind: 'unit', step: 'shows what happened in place of the screen, and reloads the editor' }
    ],
    gaps: [{ missing: 'No e2e script makes a real editor screen throw while rendering', owner: 'projects' }]
  },
  {
    id: 'projects.show-folder',
    area: 'projects',
    intent: 'See the project’s files in Finder or Explorer',
    start: 'A project open',
    routes: ['item:Toolbar:Show project folder'],
    outcome: 'The project folder is handed to the desktop to reveal (recorded, not opened, in a test launch)',
    scenario: 'none',
    proof: [],
    gaps: [{ missing: 'No test chooses Show project folder from the toolbar’s project menu', owner: 'projects' }]
  },
  {
    id: 'projects.brief',
    area: 'projects',
    intent: 'Keep private notes about the client, audience and goals with the project',
    start: 'A project open',
    routes: ['command:brief', 'panel:Project › Brief'],
    outcome: 'The brief is a canonical document written only while it holds something, kept across a reopen, and undone and redone back to no brief',
    scenario: 'unit fixtures · none',
    proof: [{ test: 'tests/unit/project-brief.test.ts', kind: 'unit', step: 'saves each edit, survives reopening, and undoes and redoes back to no brief at all' }],
    gaps: [{ missing: 'No e2e script opens the Project tab or writes a brief', owner: 'projects' }]
  },
  // ---- pages ----
  {
    id: 'pages.add',
    area: 'pages',
    intent: 'Add a page, from a blank page or a ready-made layout, with a link in the header menu',
    start: 'Business or Blank site open, Pages showing',
    routes: ['tab:pages', 'panel:Pages › Add page', 'command:newpage', 'dialog:Add page › Add to header menu', 'dialog:Add page › Starter'],
    outcome: 'The page is in Pages and the project with its link in the header menu; Blank makes a page with no sections; each starter brings its page, sections and header link in one step that one Undo takes away; a title over the limit is kept whole in the form with the reason',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'add Lookbook from Pages with Add to header menu checked' },
      { test: 'tests/e2e/page-starters.mjs', kind: 'e2e', step: 'Add page offers every starter, with the page introduction first chosen' },
      { test: 'tests/e2e/text-limits.mjs', kind: 'e2e', step: 'a new page title over the limit is kept whole in the Add page form, with the reason' },
      { test: 'tests/e2e/page-starters.mjs', kind: 'e2e', step: 'Blank makes a page with no sections' },
      { test: 'tests/e2e/page-starters.mjs', kind: 'e2e', step: 'the page and its sections come in one step, and one Undo takes them all away' },
      { test: 'tests/unit/page-starters.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Add page… from the command menu is never chosen by a test', owner: 'pages' }]
  },
  {
    id: 'pages.get-started',
    area: 'pages',
    intent: 'Bring back the Get started list after hiding it',
    start: 'A new Business site with its Get started list hidden',
    routes: ['command:getstarted'],
    outcome: 'The Get started list shows again in Pages, and the hidden flag is cleared in the saved first-steps record',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/unit/first-steps.test.ts', kind: 'unit', step: 'reads a record back from the workspace file, and nothing that is not one' },
      { test: 'tests/e2e/design/first-steps.mjs', kind: 'design' }
    ],
    gaps: [{ missing: 'No e2e script chooses Show Get started from the command menu and checks the list is back; only the opt-in design capture shows the command', owner: 'pages' }]
  },
  {
    id: 'pages.child',
    area: 'pages',
    intent: 'Put a page inside another page',
    start: 'Business site open, Pages showing',
    routes: ['item:Pages:Add page inside', 'item:Pages:Move under *', 'inspector:Page settings › Parent page', 'item:Inspector:*, as it is', 'item:Inspector:Top level'],
    outcome: 'Pages lists the child under its parent, its address nests under the parent’s, the header menu groups its link, and Move under puts a page moved in its settings where Pages shows it',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'add Lookbook, then Kitchens inside it from Lookbook’s options' },
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'Pages shows Kitchens inside Lookbook, and the header menu groups its link under Lookbook’s' },
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'move Kitchens into Work from its page settings: Move under lists it in Work, the menu stays as it was' },
      { test: 'tests/unit/child-pages.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'pages.rename',
    area: 'pages',
    intent: 'Rename a page or change its address, and have its heading, menu link and old links follow',
    start: 'Business site with a page added under one name',
    routes: ['item:Pages:Rename', 'inspector:Page settings › Title', 'item:Pages:Page settings', 'inspector:Page settings › Page address'],
    outcome: 'A rename offers the heading and header link that still say the old name and updates the chosen ones in one undo step while the address stays; a label the author changed is not offered; an inline rename over the limit keeps the old title; a typed address is kept, a Japanese title gets its natural address, and the static export sends the old address on to the new one',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'rename it Portfolio from Pages: the heading and header link are offered' },
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'update both: the heading and header link follow, the address stays' },
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'rename from the inspector, choosing only the heading' },
      { test: 'tests/e2e/text-limits.mjs', kind: 'e2e', step: 'an inline rename over the limit keeps the old title' },
      { test: 'tests/unit/page-navigation.test.ts', kind: 'unit' },
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'a page titled in Japanese gets its natural address, and another one typed in Page address' },
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'the old address sends visitors on to the new one' },
      { test: 'tests/unit/unicode-addresses.test.ts', kind: 'unit' },
      { test: 'tests/unit/routes.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'pages.menus',
    area: 'pages',
    intent: 'Change the order of pages, and edit the header and footer menus',
    start: 'Business site with child pages, an external menu link and a page outside the menu',
    routes: ['item:Pages:Move up', 'item:Pages:Move down', 'panel:Pages › Match the header menu', 'panel:Pages › Edit menu', 'inspector:Footer › Copy from header menu'],
    outcome: 'Moving a page says the header menu kept its order; matching it makes page links follow Pages while the external link stays; Edit menu shows the grouping and ungrouping a link leaves the page where it is; Copy from header menu fills the footer’s links; each has its own Undo; the exported submenu works by keyboard and touch',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'moving a page in the menu says the menu kept its order' },
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'match the header menu: page links follow Pages, the external link stays, Notes stays out' },
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'the Undo beside it takes the menu back, leaving Pages as moved' },
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'Edit menu shows the grouping, and ungrouping the link leaves the page where it is' },
      { test: 'tests/e2e/page-navigation.mjs', kind: 'e2e', step: 'Copy from header menu fills the footer’s links' },
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'desktop: Enter, Tab and Escape; Space; focus and pointer leaving close it' },
      { test: 'tests/e2e/pages-header.mjs', kind: 'e2e', step: 'the header fits at the default width and down to the minimum' },
      { test: 'tests/unit/header-menu.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'pages.home',
    area: 'pages',
    intent: 'Make another page the home page',
    start: 'Business site published under a sub-path, exported once',
    routes: ['item:Pages:Make home page…'],
    outcome: 'The confirmation names both address changes and the header and footer links to review before anything changes; after the next export an old bookmark to the page still reaches it, with and without JavaScript, and custom menu labels survive',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/home-address.mjs', kind: 'e2e', step: 'Make home page… explains both moves and the links to review before changing anything' },
      { test: 'tests/e2e/home-address.mjs', kind: 'e2e', step: 'second export: the old bookmark still reaches About, with and without JavaScript' },
      { test: 'tests/e2e/home-address.mjs', kind: 'e2e', step: 'menu labels and unrelated links survive' }
    ]
  },
  {
    id: 'pages.manage',
    area: 'pages',
    intent: 'Duplicate a page, keep one as a draft, or delete one',
    start: 'Business site, a page’s options open in Pages',
    routes: ['item:Pages:Duplicate', 'item:Pages:Make draft', 'item:Pages:Publish page', 'item:Pages:Delete page…'],
    outcome: 'A duplicated draft stays a draft; a draft is previewed but left out of the export and sitemap, and Home can never be one; the export lists drafts left out and published links to them; links to a deleted page go to the replacement chosen, and removing Home hands Home to the first published page',
    scenario: 'unit fixtures · none',
    proof: [
      { test: 'tests/unit/draft-pages.test.ts', kind: 'unit', step: 'keeps a duplicated draft a draft' },
      { test: 'tests/unit/draft-pages.test.ts', kind: 'unit', step: 'never makes the Home page a draft' },
      { test: 'tests/unit/draft-pages.test.ts', kind: 'unit', step: 'lists the pages to publish, the drafts left out, and published links that go to a draft' },
      { test: 'tests/unit/page-remove-links.test.ts', kind: 'unit' },
      { test: 'tests/unit/draft-pages.test.ts', kind: 'unit', step: 'hands Home to the first published page when Home is removed, never to a draft' }
    ],
    gaps: [
      { missing: 'No e2e script chooses Duplicate in Pages (page-languages.mjs duplicates through the project API)', owner: 'pages' },
      { missing: 'No e2e script chooses Make draft or Publish page', owner: 'pages' },
      { missing: 'No e2e script chooses Delete page… (design-capture.mjs only photographs its dialog)', owner: 'pages' }
    ]
  },
  {
    id: 'pages.switch',
    area: 'pages',
    intent: 'Go to another page to edit it',
    start: 'Business site with two pages of the same title',
    routes: ['panel:Pages › page row', 'toolbar:Page menu', 'command:page:*', 'command:page:more', 'item:Toolbar:<data>', 'panel:Layers › head switcher', 'item:page-switch:<data>'],
    outcome: 'The toolbar’s page menu and the command menu tell same-title pages apart by address, find a page by its address, follow a rename, and open the page shown when chosen by keyboard; the head of Layers names the page, layout or component it shows and opens another page from the same list',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/page-switchers.mjs', kind: 'e2e', step: 'toolbar page menu shows each address' },
      { test: 'tests/e2e/page-switchers.mjs', kind: 'e2e', step: 'command menu shows and searches by address' },
      { test: 'tests/e2e/page-switchers.mjs', kind: 'e2e', step: 'both menus follow a rename' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'another page: chosen in Pages, its heading edited' },
      { test: 'tests/unit/page-switch.test.ts', kind: 'unit' },
      { test: 'tests/unit/layers-panel-browser.test.ts', kind: 'unit', step: 'names the page Layers shows in its head, and switches page from there (#953)' },
      { test: 'tests/unit/layers-panel-browser.test.ts', kind: 'unit', step: 'labels a component or layout with its kind, and opens a page from it even when it is the page underneath (#953)' }
    ],
    gaps: [
      { missing: 'The command menu’s Show more pages row is never chosen by a test', owner: 'pages' },
      { missing: 'No e2e script chooses a page from the switcher in the head of Layers', owner: 'layers' }
    ]
  },
  {
    id: 'pages.shell',
    area: 'pages',
    intent: 'Leave the site’s header or footer off one landing page',
    start: 'Business site with a landing page',
    routes: ['item:Pages:Page settings', 'inspector:Page settings › Shared header', 'inspector:Page settings › Shared footer'],
    outcome: 'The canvas shows all four combinations, pages around it keep both, an edit to the shared footer reaches the landing page, and the static export renders each page’s own choice',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/page-shell.mjs', kind: 'e2e', step: 'header off, footer on: the landing page' },
      { test: 'tests/e2e/page-shell.mjs', kind: 'e2e', step: 'an edit to the shared footer reaches the landing page' },
      { test: 'tests/e2e/page-shell.mjs', kind: 'e2e', step: 'static export: each page renders its own choice' },
      { test: 'tests/unit/page-shell.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'pages.languages',
    area: 'pages',
    intent: 'Add a page in another language, linked to its original',
    start: 'Business site in English',
    routes: ['item:Pages:Page settings', 'inspector:Page settings › Language', 'inspector:Page settings › Translation of'],
    outcome: 'The preview and the exported website declare each page’s own language and list both versions on both pages; the source export carries the server hook; a site in one language keeps lang="en" and no hook',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/page-languages.mjs', kind: 'e2e', step: 'About duplicated as À propos, then given French and linked in Page settings' },
      { test: 'tests/e2e/page-languages.mjs', kind: 'e2e', step: 'the exported website declares the same' },
      { test: 'tests/unit/page-languages.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'pages.seo',
    area: 'pages',
    intent: 'Set how a page looks in search results and when its link is shared',
    start: 'Business site, a page’s settings open',
    routes: ['item:Pages:Page settings', 'inspector:Page settings › Search & sharing'],
    outcome: 'The search result, title meter, link card and structured data follow what is typed before it is saved; a page’s own sharing photo or the site’s is shown and labelled; the exported pages carry the same og:image addresses after a reopen; over-long text is kept whole and refused',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/seo-view.mjs', kind: 'e2e', step: 'the search result and the title meter follow the browser title as it is typed, before it is saved (#597)' },
      { test: 'tests/e2e/page-sharing.mjs', kind: 'e2e', step: 'two pages with different photos, chosen from the visual picker' },
      { test: 'tests/e2e/page-sharing.mjs', kind: 'e2e', step: 'the exported pages carry the same og:image addresses' },
      { test: 'tests/e2e/text-limits.mjs', kind: 'e2e', step: 'a pasted 342-character description stays whole, refused beside the field, and nothing is saved' },
      { test: 'tests/unit/seo-preview.test.ts', kind: 'unit' },
      { test: 'tests/unit/sharing.test.ts', kind: 'unit' },
      { test: 'tests/unit/serp.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'The search and sharing previews still live in each page’s settings; moving them into the SEO view is still to come', owner: 'pages', issue: 699 }]
  },
  {
    id: 'pages.seo-view',
    area: 'pages',
    intent: 'Look over every page and post for search in one place',
    start: 'Business site with a blog post and a draft, a section of Home selected',
    routes: ['tab:seo', 'command:panel:*', 'panel:SEO › document list'],
    outcome: 'The view opens in the canvas’s place and lists the pages in the site’s page order, then the posts by collection, drafts included; choosing one shows it as the view’s document; no key or command acts on the covered canvas; leaving by the rail entry, another panel or a page chosen in the toolbar brings the canvas back with the same preview and selection; a chosen post deleted meanwhile leaves nothing chosen',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/seo-view.mjs', kind: 'e2e', step: 'the rail entry opens the SEO view over the canvas, which stays loaded out of reach' },
      { test: 'tests/e2e/seo-view.mjs', kind: 'e2e', step: 'the list: pages in the site’s page order, then posts by collection, drafts included' },
      { test: 'tests/e2e/seo-view.mjs', kind: 'e2e', step: 'no key acts on the section selected under the view' },
      { test: 'tests/e2e/seo-view.mjs', kind: 'e2e', step: 'the rail entry again leaves the view: the canvas is back as it was, the same preview and the same selection' },
      { test: 'tests/e2e/seo-view.mjs', kind: 'e2e', step: 'the chosen post deleted while the view is open: the view falls back to nothing chosen' }
    ],
    gaps: [{ missing: 'The view lists and chooses documents; their previews, search settings and a site-wide overview there are still to come', owner: 'pages', issue: 699 }]
  },
  {
    id: 'pages.seo-health',
    area: 'pages',
    intent: 'Find what is holding the site back in search and AI answers, and fix it',
    start: 'Business site with no public URL, Home hidden from search, an undescribed page and post picture, a “Click here!” link',
    routes: ['command:health', 'dialog:Project health › Search & AI readiness'],
    outcome: 'Project health counts the findings by pillar and severity, each count matching its rows; each finding leads to the field or element that fixes it, and a row fixed while the dialog is open goes without moving focus elsewhere',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/seo-health.mjs', kind: 'e2e', step: 'Project health counts Search & AI readiness on its own, by pillar, every count matching its rows' },
      { test: 'tests/e2e/seo-health.mjs', kind: 'e2e', step: 'site: Go to Public URL opens Site details at the field' },
      { test: 'tests/e2e/seo-health.mjs', kind: 'e2e', step: 'element: from the post, Show on page selects the link’s menu in the shared header' },
      { test: 'tests/unit/seo-audit.test.ts', kind: 'unit' },
      { test: 'tests/unit/seo-health.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'pages.outline',
    area: 'pages',
    intent: 'Check the page’s heading outline',
    start: 'A page open',
    routes: ['command:outline'],
    outcome: 'The outline lists the page’s headings in order, with the shared header and footer around them, and leaves out a heading with no words',
    scenario: 'unit fixtures · none',
    proof: [{ test: 'tests/unit/heading-outline.test.ts', kind: 'unit' }],
    gaps: [{ missing: 'No e2e script opens the page outline', owner: 'pages' }]
  },
  {
    id: 'pages.header-notice',
    area: 'pages',
    intent: 'Put a short notice across the top of every page',
    start: 'Business site, the shared header selected in Layers',
    routes: ['tab:layers', 'inspector:Header › Notice'],
    outcome: 'The Inspector names the pages that inherit the header; the notice and its link show on Home and on a direct visit to Contact in the static export, wrap above the phone menu button, and go from both when cleared',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/header-notice.mjs', kind: 'e2e', step: 'select the shared header in Layers: the Inspector names the three pages that inherit it' },
      { test: 'tests/e2e/header-notice.mjs', kind: 'e2e', step: 'static export: Home and a direct visit to Contact both show the notice' },
      { test: 'tests/e2e/header-notice.mjs', kind: 'e2e', step: 'remove the notice once: both pages update' }
    ]
  },
  // ---- layers ----
  {
    id: 'layers.select',
    area: 'layers',
    intent: 'Pick an element on the page or in Layers, or the one around it',
    start: 'Business site open, nothing selected',
    routes: ['canvas:click', 'canvas:double-click', 'item:Canvas:Select *', 'item:Inspector:Select *', 'key:Escape', 'tab:layers', 'panel:Layers › row', 'item:Inspector:<data>', 'item:StatusBar:<data>'],
    outcome: 'A first click picks the section and the next the card or heading inside it; the editor’s selection is the element clicked; a code component’s placement, then its marked part, are picked in turn; a section picked in Layers is selected and scrolled into view, and picking it again brings it back after the page has scrolled away',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'inline text: the heading selected in two clicks' },
      { test: 'tests/e2e/snapshot.mjs', kind: 'driver', step: 'the preview’s heading is located, selected, and seen as the editor’s selection' },
      { test: 'tests/e2e/smoke.mjs', kind: 'e2e', step: 'select the hero, then its heading' },
      { test: 'tests/e2e/code-slots.mjs', kind: 'e2e', step: 'a click on the marked element selects the placement, the next one its part' },
      { test: 'tests/unit/selection.test.ts', kind: 'unit', step: 'goes section, then card, then the card’s heading' },
      { test: 'tests/e2e/keep-selection.mjs', kind: 'e2e', step: 'Gallery picked in Layers shows at desktop width' },
      { test: 'tests/e2e/keep-selection.mjs', kind: 'e2e', step: 'clicking the selected Gallery row again brings it back once the page has scrolled away' },
      { test: 'tests/e2e/reveal.mjs', kind: 'e2e', step: 'open the FAQ on Contact from Layers' },
      { test: 'tests/unit/layers.test.ts', kind: 'unit' },
      { test: 'tests/unit/keep-selection.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Select <the element around it> in the canvas and Inspector menus, and Escape stepping out to it, are never chosen by an e2e script', owner: 'layers' }]
  },
  {
    id: 'layers.multi-select',
    area: 'layers',
    intent: 'Select several layers and act on them together',
    start: 'Business site open, Layers showing',
    routes: ['panel:Layers › Shift-click', 'panel:Layers › Cmd/Ctrl-click', 'panel:Layers › Shift+↑/↓', 'key:Escape'],
    outcome: 'Shift picks a range of side-by-side rows and a plain click one row; layers that cannot go together are refused with a reason; Escape keeps only the selection; acting on the set is one change that keeps their order',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'modifiers are held for a click and let go after it: Shift selects a range of rows, a plain click one row' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'select two sections by keyboard alone and move them to another page as one change (#167)' },
      { test: 'tests/e2e/wrap.mjs', kind: 'e2e', step: 'Shift-click picks both buttons in Layers' },
      { test: 'tests/unit/layer-set.test.ts', kind: 'unit' },
      { test: 'tests/unit/layer-group.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'layers.reorder-drag',
    area: 'layers',
    intent: 'Reorder sections by dragging them',
    start: 'Business site Home, a section selected',
    routes: ['canvas:drag section grip', 'panel:Layers › drag row'],
    outcome: 'The section dragged by its canvas grip, or its Layers row dragged, lands in its new place as one change, saved in the page document; a grip drag held at the canvas edge scrolls the page and drops where the line shows',
    scenario: 'welcome · none; Business starter · none',
    proof: [
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'reorder by the canvas grip' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'reorder in Layers' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'drag to reorder: canvas grip and layers' },
      { test: 'tests/e2e/drag-scroll.mjs', kind: 'e2e', step: 'held at the bottom edge, the page scrolls with no more movement' },
      { test: 'tests/e2e/drag-scroll.mjs', kind: 'e2e', step: 'the release moves the section to the place shown' }
    ]
  },
  {
    id: 'layers.move',
    area: 'layers',
    intent: 'Move elements up, down, into a container or to another page, without dragging',
    start: 'Business site, one element or several layers selected',
    routes: ['key:ArrowUp', 'key:ArrowDown', 'item:Layers:Move up', 'item:Layers:Move down', 'item:Canvas:Move up', 'item:Canvas:Move down', 'item:Layers:Move into…', 'item:Layers:Move within…', 'item:Layers:Before *', 'item:Layers:To the end', 'item:Layers:Move to page…', 'item:Layers:<data>'],
    outcome: 'Shift+Cmd/Ctrl+↓ on a Layers row moves it one place as one change named in History; several layers move as a block, into a container in their order, and two sections move to the end of another page as one change',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/history-steps.mjs', kind: 'e2e', step: 'edits made with the editor’s own controls' },
      { test: 'tests/unit/layer-set.test.ts', kind: 'unit', step: 'moves a run up and down as a block' },
      { test: 'tests/unit/layer-set.test.ts', kind: 'unit', step: 'moves them into a container in their order' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'select two sections by keyboard alone and move them to another page as one change (#167)' },
      { test: 'tests/unit/layer-set.test.ts', kind: 'unit', step: 'moves two sections to the end of another page, in order, and off this one' }
    ],
    gaps: [{ missing: 'Move up, Move down, Move into… and Move within… (Before…, To the end) in the Layers and canvas menus, and Shift+Cmd/Ctrl+↑, are never chosen by an e2e script', owner: 'layers' }]
  },
  {
    id: 'layers.duplicate-delete',
    area: 'layers',
    intent: 'Duplicate or delete an element',
    start: 'Business site, a Layers row selected',
    routes: ['key:d', 'item:Layers:Duplicate', 'item:Canvas:Duplicate', 'item:Inspector:Duplicate', 'item:Inspector:Duplicate *', 'key:Delete', 'key:Backspace', 'item:Layers:Delete', 'item:Canvas:Delete', 'item:Inspector:Delete', 'item:Inspector:Delete *'],
    outcome: 'Cmd/Ctrl+D puts a copy right after the original and Delete removes it, each one change listed in History by what it did and where; several layers are copied or deleted together; a deleted section can be pasted back on another page',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/history-steps.mjs', kind: 'e2e', step: 'edits made with the editor’s own controls' },
      { test: 'tests/unit/layer-set.test.ts', kind: 'unit', step: 'duplicates Gallery and Testimonials together' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'copy a section, delete it, then paste it on another page' },
      { test: 'tests/unit/layer-set.test.ts', kind: 'unit', step: 'deletes them all' },
      { test: 'tests/e2e/delete-nested-content.mjs', kind: 'e2e', step: 'the Delete key asks first, with Cancel holding the focus, and Enter on it changes nothing' },
      { test: 'tests/e2e/delete-nested-content.mjs', kind: 'e2e', step: 'Delete all takes the Split and everything in it as one change; the library keeps its components; one Undo puts it all back' },
      { test: 'tests/e2e/delete-nested-content.mjs', kind: 'e2e', step: 'Remove wrapper & keep content, from the Layers menu, puts what the Split held in its place, selected, as one change' },
      { test: 'tests/e2e/delete-nested-content.mjs', kind: 'e2e', step: 'an empty Section is deleted at once, with no question' },
      { test: 'tests/e2e/copy-paste.mjs', kind: 'e2e', step: 'an element just inserted from the Insert panel answers ⌘C and Backspace, with focus still on its tile (#898)' },
      { test: 'tests/unit/delete-nested.test.ts', kind: 'unit' }
    ],
    gaps: [
      { missing: 'Duplicate in the Layers, canvas and Inspector menus is never chosen by an e2e script', owner: 'layers' },
      { missing: 'Delete in the Layers, canvas and Inspector menus is never chosen by an e2e script', owner: 'layers' }
    ]
  },
  {
    id: 'layers.rename',
    area: 'layers',
    intent: 'Give a layer a name of my own',
    start: 'Business site, Layers showing',
    routes: ['item:Layers:Rename', 'panel:Layers › F2'],
    outcome: 'The layer’s name field takes typing, keeps its own right-click for the name, and a given name stays after the copy changes',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/spelling.mjs', kind: 'e2e', step: 'a layer’s name field keeps its right-click for the name being typed' },
      { test: 'tests/unit/layers.test.ts', kind: 'unit', step: 'keep a name the author gave after the copy changes' }
    ]
  },
  {
    id: 'layers.copy-paste',
    area: 'layers',
    intent: 'Copy a section to another page',
    start: 'Business site Home, Gallery selected',
    routes: ['key:c', 'key:v', 'item:CopyPaste:Copy', 'item:CopyPaste:Paste', 'command:copy', 'command:paste', 'canvas:Paste'],
    outcome: 'Gallery copied on Home is pasted on Contact after the section named; Cmd/Ctrl+V works the moment a page switcher has picked the page; Paste is unavailable until something is copied; a text field keeps its own paste; an empty page offers Paste in place of its first section',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/copy-paste.mjs', kind: 'e2e', step: 'Copy and Paste are in the Layers menu, and Paste is unavailable until something is copied' },
      { test: 'tests/e2e/copy-paste.mjs', kind: 'e2e', step: 'with focus still on the switcher' },
      { test: 'tests/e2e/copy-paste.mjs', kind: 'e2e', step: 'the command menu copies and pastes too' },
      { test: 'tests/e2e/copy-paste.mjs', kind: 'e2e', step: 'an empty page offers Paste where its first section would go' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'copy a section, delete it, then paste it on another page' },
      { test: 'tests/unit/copy-paste-menus.test.ts', kind: 'unit' },
      { test: 'tests/unit/cross-project-paste.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'layers.wrap',
    area: 'layers',
    intent: 'Group elements in a Stack, Row or Grid, and ungroup them',
    start: 'Blank site, a section holding a heading, two buttons and a paragraph',
    routes: ['key:g', 'item:WrapItems:Wrap* in *', 'item:WrapItems:Ungroup*', 'item:WrapItems:Ungroup'],
    outcome: 'Two buttons are wrapped in a Row from their Layers menu as one change that one Undo takes back; the Row’s menu ungroups it as one change; Cmd/Ctrl+G and Shift+Cmd/Ctrl+G wrap and ungroup the heading once each',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/wrap.mjs', kind: 'e2e', step: 'their menu wraps them in a Row as one change' },
      { test: 'tests/e2e/wrap.mjs', kind: 'e2e', step: 'the Row’s menu in Layers ungroups it, as one change, and selects both buttons' },
      { test: 'tests/e2e/wrap.mjs', kind: 'e2e', step: 'Cmd/Ctrl+G wraps the selected heading in a Stack' },
      { test: 'tests/unit/wrap.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'layers.hide',
    area: 'layers',
    intent: 'Hide an element on phones only, and find what is hiding something',
    start: 'Business site, Layers showing at phone width',
    routes: ['panel:Layers › eye', 'item:Layers:Select *'],
    outcome: 'The eye hides or shows the layer at the previewed size only, taking that size’s own exception first; a layer hidden by its container names the nearest one and can select it',
    scenario: 'unit fixtures · none',
    proof: [
      { test: 'tests/unit/layers.test.ts', kind: 'unit', step: 'hides a layer on one size only' },
      { test: 'tests/unit/layers.test.ts', kind: 'unit', step: 'explains a hide inherited from a container, only at the size it applies to, naming the nearest' },
      { test: 'tests/e2e/conditions.mjs', kind: 'e2e', step: 'a layer the preview shows nowhere stays selectable, with its rule' }
    ],
    gaps: [{ missing: 'No e2e script presses the eye in Layers or chooses Select <what hides it>', owner: 'layers' }]
  },
  {
    id: 'layers.slots',
    area: 'layers',
    intent: 'Fill an empty slot of a placed component from Layers',
    start: 'Blank site: a Section holding a Split with an empty Main and a Sidebar that takes one text or button, and paragraphs beside it',
    routes: ['tab:layers', 'panel:Layers › slot row', 'panel:Layers › drag onto a slot row', 'panel:Insert › tile'],
    outcome: 'Layers lists the slots in the order the component declares them, each marked empty; a picked slot is where an Insert tile goes, one Undo empties it, and Escape lets it go; a drop the slot’s contract refuses changes nothing, an allowed one moves in as one change, in order; the arrow keys reach the slot rows',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/layers-slots.mjs', kind: 'e2e', step: 'expanding the Split lists both slots in the order it declares them, each marked empty' },
      { test: 'tests/e2e/layers-slots.mjs', kind: 'e2e', step: 'clicking the empty Sidebar row picks it, and a Paragraph tile clicked in Insert goes into it' },
      { test: 'tests/e2e/layers-slots.mjs', kind: 'e2e', step: 'two paragraphs dragged together onto the empty Sidebar, which takes one, are refused whole' },
      { test: 'tests/e2e/layers-slots.mjs', kind: 'e2e', step: 'a paragraph dragged alone onto the empty Sidebar row moves into it, as one change' },
      { test: 'tests/e2e/layers-slots.mjs', kind: 'e2e', step: 'the slot rows are tree items the keys reach: Up/Down pick them, Left goes back to the Split' },
      { test: 'tests/e2e/split-layout.mjs', kind: 'e2e', step: 'Layers lists Primary then Secondary, both empty' },
      { test: 'tests/e2e/split-layout.mjs', kind: 'e2e', step: 'with Primary picked in Layers, Insert puts a Statistics section and then a Heading in it' }
    ]
  },
  {
    id: 'layers.item-step',
    area: 'layers',
    intent: 'Step to the same part in the next card',
    start: 'Business site, a Services card’s title picked on the page',
    routes: ['canvas:selection chip › Next item', 'canvas:selection chip › Previous item'],
    outcome: 'Next and Previous select the same title in the next card and back, by pointer and keyboard, scrolling it into view, stepping over cards that hide the part, and never changing the cards',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/item-step.mjs', kind: 'e2e', step: 'Next selects the title in the next card' },
      { test: 'tests/e2e/item-step.mjs', kind: 'e2e', step: 'stepping only moved the selection' },
      { test: 'tests/unit/item-step.test.ts', kind: 'unit' }
    ]
  },
  // ---- inspector ----
  {
    id: 'inspector.edit-text',
    area: 'inspector',
    intent: 'Change the words on the page, with bold, links and lists',
    start: 'Business site Home, the hero heading or a paragraph selected',
    routes: ['canvas:double-click text', 'item:Canvas:Edit text', 'inspector:Content › Heading', 'canvas:rich text toolbar', 'inspector:Content › rich text toolbar'],
    outcome: 'Typed text is committed to the page document and shown in the Inspector; bold, italic, a page link, line breaks and lists are saved as the field’s rich text, from buttons alone too; rich text the project refuses goes back to what was saved',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'edited after a double click, typed over and committed' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'the Inspector shows the committed text' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'inline text edit' },
      { test: 'tests/e2e/inspector-canvas-pick.mjs', kind: 'e2e', step: 'click another section on the canvas: the hero keeps what was typed, the section clicked keeps its own' },
      { test: 'tests/unit/inspector-leave.test.ts', kind: 'unit' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'rich text the project refuses goes back to what was saved' },
      { test: 'tests/unit/canvas-writing.test.ts', kind: 'unit' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'inline rich text: bold, italic and a page link' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'inline rich text: the word double-clicked, and line breaks inside a paragraph (#175)' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'lists and links from buttons alone, in Insert, the Inspector and on the canvas (issue #43)' },
      { test: 'tests/unit/richtext.test.ts', kind: 'unit' },
      { test: 'tests/unit/richtext-commands.test.ts', kind: 'unit' },
      { test: 'tests/unit/rich-toolbar.test.ts', kind: 'unit' },
      { test: 'tests/unit/inline-link.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.fields',
    area: 'inspector',
    intent: 'Change an element’s settings in the Inspector, including text longer than a field allows',
    start: 'Business site, an element or a page’s settings in the Inspector',
    routes: ['inspector:Content › select', 'inspector:Content › text field', 'inspector:Page settings › Description', 'inspector:Image › Description'],
    outcome: 'A select chosen by its label moves the project one step; pasted text over a field’s limit stays whole, marked Not saved, and nothing reaches the project; it is found again after leaving and coming back; shortened, it saves and the page renders it; Escape puts the saved text back',
    scenario: 'welcome · none; Business starter · none',
    proof: [
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'a select in the Inspector, chosen by its label, moves the project one step' },
      { test: 'tests/unit/inspector-fields.test.ts', kind: 'unit' },
      { test: 'tests/unit/inspector-workflows.test.ts', kind: 'unit' },
      { test: 'tests/e2e/text-limits.mjs', kind: 'e2e', step: 'a pasted 328-character image description in the Home hero stays whole and refused' },
      { test: 'tests/e2e/text-limits.mjs', kind: 'e2e', step: 'shortened, the image description saves and the canvas renders it as the alt' },
      { test: 'tests/e2e/text-limits.mjs', kind: 'e2e', step: 'Escape puts the saved text back' },
      { test: 'tests/unit/text-limits.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.lists',
    area: 'inspector',
    intent: 'Edit the cards or questions in a repeated list',
    start: 'Business site, a Services grid or the FAQ on Contact selected',
    routes: ['inspector:Content › list › Add', 'inspector:Content › list › Move', 'inspector:Content › list › Remove', 'inspector:Content › list item', 'canvas:click the revealed answer'],
    outcome: 'A list stops at its capacity and keeps focus on a moved item; History and Undo name the card and what was done to it; an FAQ question opened in the Inspector opens on the canvas and shows its answer as it is typed, with nothing of it saved',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'repeatable lists: capacity, and focus after a move to either end' },
      { test: 'tests/e2e/list-history.mjs', kind: 'e2e', step: 'an add names the card and the list' },
      { test: 'tests/e2e/list-history.mjs', kind: 'e2e', step: 'Undo says what it will undo' },
      { test: 'tests/unit/list-editor.test.ts', kind: 'unit' },
      { test: 'tests/e2e/reveal.mjs', kind: 'e2e', step: 'opening a question in the inspector reveals it on the page' },
      { test: 'tests/e2e/reveal.mjs', kind: 'e2e', step: 'the answer shows as it is typed, at phone and desktop widths, with the caret kept in the field' },
      { test: 'tests/unit/reveal-item.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.scoped-style',
    area: 'inspector',
    intent: 'Style a section on phones only, or one card without the others',
    start: 'Business site, a section or a pricing plan selected',
    routes: ['inspector:Style › Phone', 'toolbar:Phone', 'inspector:Style'],
    outcome: 'The phone-only padding override is saved on the section and leaves other sizes alone; an Alt drag while Phone is previewed writes exact pixels to the Phone override only; a style given to one pricing plan leaves its siblings as they were',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'phone-only padding override on selected section' },
      { test: 'tests/e2e/spacing-handles.mjs', kind: 'e2e', step: 'previewing Phone: an Alt drag writes exact pixels to the Phone override only' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'a breakpoint chosen' },
      { test: 'tests/unit/styles.test.ts', kind: 'unit' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'style one pricing plan without restyling the others (#81)' },
      { test: 'tests/unit/item-styles.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.states',
    area: 'inspector',
    intent: 'Style how a card looks on hover and focus',
    start: 'Business site, a Services card selected from the canvas',
    routes: ['inspector:State › Hover', 'inspector:State › Default', 'inspector:State › Reset'],
    outcome: 'The hover background shows on the canvas while Hover is chosen and at rest in Default, in Preview and on another card; the site gets a plain hover rule with nothing of the forced state; reset takes one state or all back',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/style-states.mjs', kind: 'e2e', step: 'choose Hover and give the card a red hover background' },
      { test: 'tests/e2e/style-states.mjs', kind: 'e2e', step: 'the site gets a plain hover rule; nothing of the forced state' },
      { test: 'tests/e2e/style-states.mjs', kind: 'e2e', step: 'a hover and a focus background, both reset at once' },
      { test: 'tests/unit/style-states.test.ts', kind: 'unit' },
      { test: 'tests/unit/inspector-states.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.copy-style',
    area: 'inspector',
    intent: 'Copy one section’s style onto another',
    start: 'Business site Home, the Split hero with its own padding',
    routes: ['item:StylePaste:Copy style', 'item:StylePaste:Paste style…'],
    outcome: 'The hero’s padding, at all sizes and on phones, is pasted onto Content with image without its text, link or photo, as one change one Undo takes back; Phone only pastes the phone values alone',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/style-paste.mjs', kind: 'e2e', step: 'copy the hero’s style from its actions menu' },
      { test: 'tests/e2e/style-paste.mjs', kind: 'e2e', step: 'paste it onto Content with image from its Layers menu' },
      { test: 'tests/e2e/style-paste.mjs', kind: 'e2e', step: 'paste Phone only from the section’s own actions menu' },
      { test: 'tests/unit/style-copy.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.handles',
    area: 'inspector',
    intent: 'Drag spacing, gaps, widths and column sizes on the page',
    start: 'Business site Home, the Split hero or a two-column layout selected',
    routes: ['canvas:padding handle', 'canvas:gap handle', 'canvas:max width handle', 'canvas:column divider'],
    outcome: 'Each drag snaps to a spacing style or Reading width as it moves, saves one edit on release that one Undo takes back, and Escape mid-drag saves nothing; a column divider saves 1fr 2fr that phones leave alone',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/spacing-handles.mjs', kind: 'e2e', step: 'release: one edit saves the spacing style for all sizes' },
      { test: 'tests/e2e/spacing-handles.mjs', kind: 'e2e', step: 'Escape mid-drag puts the page back and saves nothing' },
      { test: 'tests/e2e/layout-handles.mjs', kind: 'e2e', step: 'release: one edit saves the gap for all sizes, and one Undo takes it back' },
      { test: 'tests/e2e/layout-handles.mjs', kind: 'e2e', step: 'drag the divider a third of the way across' },
      { test: 'tests/unit/spacing-drag.test.ts', kind: 'unit' },
      { test: 'tests/unit/layout-drag.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.image-focus',
    area: 'inspector',
    intent: 'Choose what stays in view when a photo is cropped',
    start: 'Business site Home hero, cropped to 16:9 on phones',
    routes: ['inspector:Image › Focus point', 'inspector:Image › Center'],
    outcome: 'Dragging on the picture or typing sets the focus for one size and one placement; the canvas, the stylesheet and the export follow; a drag released outside stops at the edge; Escape cancels; Undo takes back one change at a time',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/focus.mjs', kind: 'e2e', step: 'drag the focal point up toward her face' },
      { test: 'tests/e2e/focus.mjs', kind: 'e2e', step: 'type the focus with the keyboard' },
      { test: 'tests/e2e/focus.mjs', kind: 'e2e', step: 'Undo takes back one change at a time' },
      { test: 'tests/unit/focus.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.contact-form',
    area: 'inspector',
    intent: 'Set up a contact form that sends to me, and try it without sending real email',
    start: 'Business site with a Contact form',
    routes: ['inspector:Form › Service', 'inspector:Form › Fields', 'inspector:Form › Send a live test', 'preview:Send'],
    outcome: 'Only the setting the chosen service needs is shown, the others kept; a single-choice question’s choices are named, ordered and removed; a send in Preview is practised and nothing goes out; one real message is sent only when the author confirms a live test',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'a contact form shows only the setting its service needs, and keeps the others' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'a contact form asks a single-choice question whose choices the author names, orders and removes (issue #238)' },
      { test: 'tests/unit/contact-form.test.ts', kind: 'unit' },
      { test: 'tests/unit/form-service.test.ts', kind: 'unit' },
      { test: 'tests/unit/form-choices.test.ts', kind: 'unit' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'a contact form practises its sends in Preview' },
      { test: 'tests/unit/form-practice.test.ts', kind: 'unit' },
      { test: 'tests/unit/form-rehearsal.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.table',
    area: 'inspector',
    intent: 'Add and edit a data table',
    start: 'Business site About page',
    routes: ['panel:Insert › Data table', 'inspector:Content › Table'],
    outcome: 'The table is found and inserted, edited, undone, kept across a reopen, and fits a phone',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'a data table on About: find, insert, edit, undo, reopen and fit a phone (issue #179)' },
      { test: 'tests/unit/table.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'inspector.tone',
    area: 'inspector',
    intent: 'Change a section’s tone and layout',
    start: 'Business site, a section selected',
    routes: ['inspector:Tone', 'inspector:Layout'],
    outcome: 'Tone and layout combine on one placement, and a code component offers its tone',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'tone and layout combine, and a code component offers its tone' },
      { test: 'tests/unit/variants.test.ts', kind: 'unit' }
    ]
  },
  // ---- styles ----
  {
    id: 'styles.colors',
    area: 'styles',
    intent: 'Change the site’s colours, or make a palette from my brand colour',
    start: 'Business site, Site styles open',
    routes: ['command:styles', 'panel:Site styles › Colors', 'panel:Site styles › Colors › Palette from brand'],
    outcome: 'Every saved colour shows on its swatch, starts the picker from itself, keeps its opacity, survives a reopen in its own format and undoes as one step; a white brand colour is flagged with a readable text colour on offer; a palette from the brand previews without saving, applies in one step and one Undo puts every colour back',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/colors.mjs', kind: 'e2e', step: 'a run of steps in the picker is one undo step' },
      { test: 'tests/e2e/colors.mjs', kind: 'e2e', step: 'each format survives closing and reopening the project' },
      { test: 'tests/e2e/colors.mjs', kind: 'e2e', step: 'a white brand color is flagged where it is set, with a readable text color on offer' },
      { test: 'tests/e2e/colors.mjs', kind: 'e2e', step: 'a color that follows another stays linked' },
      { test: 'tests/unit/color.test.ts', kind: 'unit' },
      { test: 'tests/unit/contrast.test.ts', kind: 'unit' },
      { test: 'tests/e2e/colors.mjs', kind: 'e2e', step: 'a palette made from the brand previews without saving, applies in one step, and one undo puts every color back' },
      { test: 'tests/unit/palette.test.ts', kind: 'unit' },
      { test: 'tests/unit/theme-contrast.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'styles.fonts',
    area: 'styles',
    intent: 'Choose the fonts and text styles for headings and body text',
    start: 'A site with imported and bundled fonts, Site styles open',
    routes: ['panel:Site styles › Fonts', 'panel:Site styles › Text styles'],
    outcome: 'Site styles draws its samples in the chosen files; another font moves body text to it in one step; the canvas and the exported site paint the same files; a bundled font chosen by name ships; a text style of the author’s own opens in the Text styles list',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/fonts.mjs', kind: 'e2e', step: 'Site styles draws its samples in the imported files' },
      { test: 'tests/e2e/fonts.mjs', kind: 'e2e', step: 'choosing another font moves body text to it in one step' },
      { test: 'tests/e2e/fonts.mjs', kind: 'e2e', step: 'the exported site paints the same files' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'a bundled font chosen by name really ships' },
      { test: 'tests/unit/fonts.test.ts', kind: 'unit' },
      { test: 'tests/unit/bundled-fonts.test.ts', kind: 'unit' },
      { test: 'tests/e2e/colors.mjs', kind: 'e2e', step: 'a text style of your own opens in the Text styles list' },
      { test: 'tests/unit/type-scale.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'styles.theme-switch',
    area: 'styles',
    intent: 'Switch the site to another theme, including one I installed, and back',
    start: 'Business site on Foundation, Site styles open, with a pack in userData/packs beside a malformed one',
    routes: ['panel:Site styles › Theme'],
    outcome: 'Every section and what it says is kept; an installed pack loads while a malformed one is listed as refused with its reason, and switching copies its fonts into the project for the preview; switching back leaves the project exactly as it was',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/unit/theme-packs.test.ts', kind: 'unit' },
      { test: 'tests/e2e/theme-packs.mjs', kind: 'e2e', step: 'Site styles offers the installed pack, lists the refused one, and switching copies the new font in' },
      { test: 'tests/e2e/theme-packs.mjs', kind: 'e2e', step: 'the preview loads the new font from the project' },
      { test: 'tests/unit/pack-loader.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'styles.theme-update',
    area: 'styles',
    intent: 'Take the theme’s newer version of a section',
    start: 'A project whose installed hero is older than the theme’s',
    routes: ['status:Project health', 'command:health', 'dialog:Project health › Update'],
    outcome: 'Project health offers the update on opening; Update replaces the definition and its lock entry with the theme’s; Undo puts the older ones back; the page is untouched both ways',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/theme-update.mjs', kind: 'e2e', step: 'reopen: Project health offers the update' },
      { test: 'tests/e2e/theme-update.mjs', kind: 'e2e', step: 'Update replaces the definition and its lock entry with the theme’s' },
      { test: 'tests/e2e/theme-update.mjs', kind: 'e2e', step: 'Undo puts the older definition back' }
    ],
    gaps: [{ missing: 'The test opens Project health from the status bar; the command menu’s Project health… is not taken', owner: 'styles' }]
  },
  // ---- insert ----
  {
    id: 'insert.panel',
    area: 'insert',
    intent: 'Add a section from the Insert panel, in the variant I want',
    start: 'Business site Home, Insert showing',
    routes: ['tab:insert', 'panel:Insert › tile', 'panel:Insert › Search', 'panel:Insert › Variants'],
    outcome: 'A pricing section is placed as one change; search finds elements by name and by the words they go by; Insert shows each section’s thumbnail and Variants inserts the option shown; a tile click names the page in History and its confirmation’s Undo takes back its own insert',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'insert pricing via Insert panel' },
      { test: 'tests/e2e/insert-destination.mjs', kind: 'e2e', step: 'a click on a tile names the page in History' },
      { test: 'tests/e2e/insert-destination.mjs', kind: 'e2e', step: 'a Gallery inserted at the end of a tall page is scrolled to as the page mounts it' },
      { test: 'tests/unit/insert-at.test.ts', kind: 'unit' },
      { test: 'tests/unit/insert-search.test.ts', kind: 'unit' },
      { test: 'tests/e2e/theme-packs.mjs', kind: 'e2e', step: 'Variants lists each option with its own thumbnail, and inserts the option shown' },
      { test: 'tests/unit/thumbs.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'insert.command',
    area: 'insert',
    intent: 'Insert something by typing its name',
    start: 'Blank site with project components, an element selected',
    routes: ['key:k', 'command:Insert:*', 'command:ins:more'],
    outcome: 'The project’s components lead, the rest wait behind Show more; each row says where it lands and Enter inserts it there; a component never goes inside itself; code components show only in Developer mode',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/command-insert.mjs', kind: 'e2e', step: 'with nothing typed, the project’s components lead Insert, and the rest open in place' },
      { test: 'tests/e2e/command-insert.mjs', kind: 'e2e', step: 'Enter inserts the highlighted one where it said' },
      { test: 'tests/e2e/command-insert.mjs', kind: 'e2e', step: 'a component edited everywhere cannot be inserted into itself' },
      { test: 'tests/unit/command-inserts.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'insert.placement',
    area: 'insert',
    intent: 'Put a new element exactly where I want it: beside the selection, or dragged into place',
    start: 'Blank site with two sections, a card selected in a grid, Insert showing',
    routes: ['panel:Insert › tile', 'canvas:drag Insert tile'],
    outcome: 'The tile names the grid before the click and the new card lands beside the selected one; a dragged tile shows a line and label before release, and each drop is one change with one Undo; a gap an Order style keeps it out of is refused with the reason; Escape cancels',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/insert-destination.mjs', kind: 'e2e', step: 'with the card selected, its tile names the grid before the click, and inserts a second card there' },
      { test: 'tests/e2e/insert-destination.mjs', kind: 'e2e', step: 'a component made from a whole section still goes after the section holding the selection' },
      { test: 'tests/unit/insert-at.test.ts', kind: 'unit' },
      { test: 'tests/e2e/insert-destination.mjs', kind: 'e2e', step: 'Gallery drags before, between and after the two sections, each in one change' },
      { test: 'tests/e2e/insert-destination.mjs', kind: 'e2e', step: 'a gap an Order style keeps it out of is refused, and says why' },
      { test: 'tests/e2e/insert-destination.mjs', kind: 'e2e', step: 'Escape cancels a drag; a tile still inserts from the keyboard afterwards' },
      { test: 'tests/e2e/blocks.mjs', kind: 'e2e', step: 'with Column 1 selected, the Feature card’s tile names the column, and its click puts the card there in one change' },
      { test: 'tests/e2e/blocks.mjs', kind: 'e2e', step: 'the Stat card’s tile drags into Column 2, in one change' },
      { test: 'tests/e2e/blocks.mjs', kind: 'e2e', step: 'the Testimonial card’s tile drags into the Proof section’s slot, in one change' },
      { test: 'tests/e2e/blocks.mjs', kind: 'e2e', step: 'the full slot takes no second block: a click on its tile with the slot’s card selected says so, and adds nothing' },
      { test: 'tests/e2e/slot-targets.mjs', kind: 'e2e', step: 'a Paragraph dragged from Insert draws a surface for each empty slot, at least 72px tall, and drops into Main' },
      { test: 'tests/e2e/slot-targets.mjs', kind: 'e2e', step: 'with Sidebar’s column collapsed to no height, a drop below where the column shows still goes into Sidebar' },
      { test: 'tests/e2e/slot-targets.mjs', kind: 'e2e', step: 'an Image dragged over Sidebar, which takes only text, says so on Sidebar; Escape leaves everything as it was' },
      { test: 'tests/e2e/slot-targets.mjs', kind: 'e2e', step: 'Preview shows no slot placeholder, and no slot address, anywhere on the page' },
      { test: 'tests/e2e/split-layout.mjs', kind: 'e2e', step: 'both slots show an empty drop target on the canvas, side by side' },
      { test: 'tests/e2e/split-layout.mjs', kind: 'e2e', step: 'a Paragraph dragged from Insert drops into Secondary, which stays on the right while Primary is empty' },
      { test: 'tests/unit/split-layout.test.ts', kind: 'unit' },
      { test: 'tests/unit/insert-drop.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'insert.canvas-add',
    area: 'insert',
    intent: 'Add something right where I am on the page',
    start: 'Blank site Home with two sections, the first holding a Row',
    routes: ['canvas:+ below a section', 'canvas:+ inside a Row'],
    outcome: 'The + below the first section adds a Gallery between the first two sections; the + inside a selected Row adds a Button in it, found from the keyboard; each is one change; Escape and a press outside put the list away; Preview shows no + buttons',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/canvas-insert.mjs', kind: 'e2e', step: 'Gallery chosen from search lands between Home’s first two sections, in one change' },
      { test: 'tests/e2e/canvas-insert.mjs', kind: 'e2e', step: 'a selected Row shows a + inside it' },
      { test: 'tests/e2e/canvas-insert.mjs', kind: 'e2e', step: 'Preview shows no Add buttons' },
      { test: 'tests/e2e/blocks.mjs', kind: 'e2e', step: 'the + inside an empty column offers every block, in its own group' },
      { test: 'tests/e2e/blocks.mjs', kind: 'e2e', step: 'the + inside the Proof section offers only the blocks its slot takes' },
      { test: 'tests/unit/inline-insert.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'insert.empty-page',
    area: 'insert',
    intent: 'Begin filling an empty page',
    start: 'A Blank site’s empty Home',
    routes: ['canvas:Add a section', 'canvas:Write with AI', 'canvas:Paste'],
    outcome: 'The canvas says how to begin between the shared header and footer, in the editor only; Add a section opens Insert with its search focused and the first section takes the note’s place; Paste is offered where the first section would go',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'Add a section opens Insert, and the first section placed takes the note’s place' },
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'Preview shows the page as visitors get it, without the note' },
      { test: 'tests/e2e/copy-paste.mjs', kind: 'e2e', step: 'an empty page offers Paste where its first section would go' }
    ]
  },
  {
    id: 'insert.columns',
    area: 'insert',
    intent: 'Lay content out in columns or an empty grid, and fill it',
    start: 'Blank site, Insert showing',
    routes: ['panel:Insert › 2 columns', 'panel:Insert › 3 columns', 'inspector:Column layout', 'panel:Insert › Grid', 'canvas:click an empty column'],
    outcome: 'One click adds a Grid of empty framed columns as one change with the first selected, and Insert fills the selected column; the frames show only while editing and never reach the project’s files; columns stack on phones; a Section placement arranges its own columns from the Inspector',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/columns.mjs', kind: 'e2e', step: '2 columns: one change adds a Grid with two empty, framed columns side by side, the first selected to fill' },
      { test: 'tests/e2e/columns.mjs', kind: 'e2e', step: 'a Section placement arranges its columns from the Inspector, without Parts' },
      { test: 'tests/unit/insert-grid-css.test.ts', kind: 'unit' },
      { test: 'tests/e2e/empty-layout.mjs', kind: 'e2e', step: 'insert a Grid from the Insert panel: it goes into a new Section and shows as a framed, three-column box' },
      { test: 'tests/e2e/empty-layout.mjs', kind: 'e2e', step: 'the project’s own files and a source export hold none of it' },
      { test: 'tests/e2e/empty-layout.mjs', kind: 'e2e', step: 'with the Grid clicked, a Paragraph inserted from the panel lands inside it' },
      { test: 'tests/unit/empty-layout.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'insert.interactive',
    area: 'insert',
    intent: 'Add a carousel, tabs or a pricing switch that work for visitors',
    start: 'Business site Home, Insert showing',
    routes: ['panel:Insert › Media › Carousel', 'panel:Insert › Content › Tabbed showcase', 'panel:Insert › Conversion › Pricing with billing switch'],
    outcome: 'In the exported site at desktop and phone width the slides and tabs work by pointer, keyboard and touch, honour reduced motion, print as a stack and stay reachable without JavaScript',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/carousel.mjs', kind: 'e2e', step: 'Insert > Media offers the Carousel, and it is placed on Home' },
      { test: 'tests/e2e/carousel.mjs', kind: 'e2e', step: 'without JavaScript every slide is still reachable' },
      { test: 'tests/e2e/showcase-pricing.mjs', kind: 'e2e', step: 'Insert offers the Tabbed showcase under Content and Pricing with billing switch under Conversion' },
      { test: 'tests/e2e/showcase-pricing.mjs', kind: 'e2e', step: 'without JavaScript every tab’s panel shows under its label, and both periods’ prices, with no tab row or switch' },
      { test: 'tests/unit/carousel.test.ts', kind: 'unit' },
      { test: 'tests/unit/foundation-interactive.test.ts', kind: 'unit' }
    ]
  },
  // ---- components ----
  {
    id: 'components.create',
    area: 'components',
    intent: 'Make a reusable component, blank or from a section on the page',
    start: 'Blank site, a section or heading selected in Layers',
    routes: ['item:Layers:Create component…', 'item:Canvas:Create component…', 'item:Inspector:Create component…', 'command:newcomponent', 'panel:Insert › Create component'],
    outcome: 'A blank component is made without Developer mode and opens its design, one Undo taking it back; a Section holding content becomes a component from its Layers row and a copy shows that content',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'Create component starts a blank one without Developer mode, opens its design, and one Undo takes it back (#172)' },
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'a Section holding content becomes a component from its Layers row, and a copy shows that content (#173)' },
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'a single heading becomes a component from its Layers row' },
      { test: 'tests/unit/create-component.test.ts', kind: 'unit' },
      { test: 'tests/unit/new-component.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Create component… in the canvas and Inspector menus is never chosen by an e2e script', owner: 'components' }]
  },
  {
    id: 'components.edit-everywhere',
    area: 'components',
    intent: 'Change a component everywhere it is placed',
    start: 'Business site, a placed component selected',
    routes: ['item:Inspector:Edit everywhere…', 'item:Insert:Edit everywhere', 'inspector:Done'],
    outcome: 'The canvas, Layers and the Inspector agree on the design being edited; a change reaches every placement',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'edit a component everywhere: canvas, layers and inspector agree' },
      { test: 'tests/e2e/repeat-as-list.mjs', kind: 'e2e', step: 'Edit everywhere opens the design' },
      { test: 'tests/unit/edit-everywhere.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.studio',
    area: 'components',
    intent: 'Work on a component on its own, with sample content and variants',
    start: 'Blank site with a project component no page places',
    routes: ['item:Insert:Open in Component Studio', 'command:studio:*', 'inspector:Done editing'],
    outcome: 'The component opens alone in the isolated preview; variant options, sample content and width change only the preview; a click picks its own part, styled there with Undo and Redo; its placement role is chosen in one undoable step; Done goes back to the page',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/component-studio.mjs', kind: 'e2e', step: 'it opens in Component Studio from Insert' },
      { test: 'tests/e2e/component-studio.mjs', kind: 'e2e', step: 'variant options and sample content change only the preview' },
      { test: 'tests/e2e/component-studio.mjs', kind: 'e2e', step: 'the Command menu opens it again' },
      { test: 'tests/e2e/component-studio.mjs', kind: 'e2e', step: 'its placement role is chosen in Component Studio, in one undoable step (#661)' },
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'an unplaced component is shown on its own, at any width (#347)' },
      { test: 'tests/unit/component-studio.test.ts', kind: 'unit' },
      { test: 'tests/unit/studio-samples.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.library',
    area: 'components',
    intent: 'See where my components are used, rename them, and delete the unused ones',
    start: 'Blank site with project components, Insert › Your components',
    routes: ['item:Insert:Rename', 'item:Insert:* · *', 'item:Insert:Delete component', 'item:Insert:Delete component…', 'panel:Insert › Your components', 'item:Insert:<data>'],
    outcome: 'Each tile says how often it is used and shows a thumbnail redrawn when its style or the brand changes; its menu lists and shows each placement; deleting a used one reviews where it is used instead; an unused one is deleted and Undo brings it back',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'usage locations show where a component is placed, and deleting a used one reviews where instead' },
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'Rename gives a variant a descriptive name and a description' },
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'deleting an unused variant keeps the others, and Undo brings it back' },
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'each component in Your components shows a thumbnail, drawn again when its style changes (#370)' },
      { test: 'tests/e2e/thumbs-brand.mjs', kind: 'e2e', step: 'a brand colour change draws again only the card that shows it' },
      { test: 'tests/unit/component-library.test.ts', kind: 'unit' },
      { test: 'tests/unit/component-thumbs.test.ts', kind: 'unit' },
      { test: 'tests/unit/thumb-reads-browser.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.duplicate',
    area: 'components',
    intent: 'Copy a component under a new name to make a variant, without moving any placement onto the copy',
    start: 'Blank site with a project component, Insert › Your components or the Inspector of a placed one',
    routes: ['item:Insert:Duplicate…', 'item:Inspector:Duplicate component…'],
    outcome: 'The copy takes the chosen name (or the next free "copy" name), every placement stays on the original, the announcement opens the copy in Component Studio, and one Undo takes the copy back',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'Duplicate copies a component under a new name, leaves every placement on it, and one Undo takes it back (#746)' },
      { test: 'tests/unit/duplicate-component.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.variant',
    area: 'components',
    intent: 'Make one placement its own component, or swap it for another design',
    start: 'A placement of a shared component selected',
    routes: ['item:Inspector:Make unique…', 'item:Inspector:Change section design…', 'item:Inspector:Change design…'],
    outcome: 'Make unique asks for a name, Cancel changes nothing and suggestions never stack “(unique)”; Change design swaps the placement’s design and keeps the content the two share',
    scenario: 'Blank starter · none; unit fixtures',
    proof: [
      { test: 'tests/e2e/component-library.mjs', kind: 'e2e', step: 'Make unique asks for a name: Cancel changes nothing, a chosen name is kept' },
      { test: 'tests/unit/component-reusability.test.ts', kind: 'unit' },
      { test: 'tests/unit/swap-component.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'No e2e script chooses Change section design… or Change design…', owner: 'components' }]
  },
  {
    id: 'components.detach',
    area: 'components',
    intent: 'Turn a placed component into plain elements I can change freely',
    start: 'Blank site with Pricing and a dark call to action placed in a section',
    routes: ['item:Inspector:Detach component', 'item:Canvas:Detach component', 'item:Layers:Detach component'],
    outcome: 'The elements that replace each placement look the same at phone, tablet and desktop widths, including its tone, repeated cards, button colours and slot content; the library gains nothing; one Undo brings the placement back',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/detach.mjs', kind: 'e2e', step: 'Detach component is offered in the Inspector, Canvas and Layers menus for the placement' },
      { test: 'tests/e2e/detach.mjs', kind: 'e2e', step: 'the detached elements look the same at every width' },
      { test: 'tests/e2e/detach.mjs', kind: 'e2e', step: 'Undo brings back each placement as it was' },
      { test: 'tests/unit/detach-instance.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.repeat',
    area: 'components',
    intent: 'Turn a static card into a list of cards',
    start: 'Blank site, a component’s grid holding one static card, edited everywhere',
    routes: ['item:Inspector:Repeat as list…', 'item:Canvas:Repeat as list…', 'item:Layers:Repeat as list…'],
    outcome: 'Cancel changes nothing; from Layers the card becomes a list of three in every placement as one change that one Undo takes back and Redo makes again; one placement then edits its second card alone',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/repeat-as-list.mjs', kind: 'e2e', step: 'the inspector’s menu offers Repeat as list…, and Cancel changes nothing' },
      { test: 'tests/e2e/repeat-as-list.mjs', kind: 'e2e', step: 'the canvas offers it too, from the card’s chip' },
      { test: 'tests/e2e/repeat-as-list.mjs', kind: 'e2e', step: 'Layers repeats the card as a list, as one change' },
      { test: 'tests/unit/repeat-as-list.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.share',
    area: 'components',
    intent: 'Use a component I made in another project, or send it as a file',
    start: 'Project A with a component, then project B',
    routes: ['item:Insert:Save to personal library', 'item:Inspector:Save to personal library', 'item:Canvas:Save to personal library', 'item:Layers:Save to personal library', 'panel:Insert › Saved across projects', 'item:Insert:Insert here', 'item:Insert:Remove from library', 'item:Insert:Export component…', 'item:Inspector:Export component…', 'item:Canvas:Export component…', 'item:Layers:Export component…', 'panel:Insert › Import component…'],
    outcome: 'Saved from project A, it shows under Saved across projects in B, where one click imports and places it as one change; saved code shows only in Developer mode and asks first; Remove from library leaves the copies; Export component… writes a file through the save chooser and Import component… brings one in without placing it',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/saved-components.mjs', kind: 'e2e', step: 'Project A: a component saved to the personal library from Your components' },
      { test: 'tests/e2e/saved-components.mjs', kind: 'e2e', step: 'The placement’s menus in the Inspector, on the canvas and in Layers offer it too' },
      { test: 'tests/e2e/saved-components.mjs', kind: 'e2e', step: 'One click imports and places it' },
      { test: 'tests/e2e/saved-components.mjs', kind: 'e2e', step: 'Remove from library takes it out of every project’s Insert, leaving the copies' },
      { test: 'tests/unit/saved-components.test.ts', kind: 'unit' },
      { test: 'tests/e2e/saved-components.mjs', kind: 'e2e', step: 'Export component… writes a file through the native save chooser' },
      { test: 'tests/e2e/saved-components.mjs', kind: 'e2e', step: 'Import component… brings a file in through the native open chooser, without placing it' },
      { test: 'tests/unit/component-package.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Insert here in a saved component’s own menu is never chosen by a test', owner: 'components' }]
  },
  {
    id: 'components.slots',
    area: 'components',
    intent: 'Give a component a slot that takes only some content',
    start: 'Blank site, a project component with an empty Body in Component Studio',
    routes: ['inspector:Add slot', 'inspector:Slot › Takes'],
    outcome: 'Add slot declares it and places it in one Undo; its name and what it takes save together; on a page it takes only what it allows; a tighter contract is refused with the engine’s reason; removing it while content is there reviews where, with a way to each placement, or takes the slot and its content in one change',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/slot-authoring.mjs', kind: 'e2e', step: 'Add slot declares Buttons and places it inside the selected Body, in one Undo' },
      { test: 'tests/e2e/slot-authoring.mjs', kind: 'e2e', step: 'placed on a page, the slot takes one paragraph and nothing else' },
      { test: 'tests/e2e/slot-authoring.mjs', kind: 'e2e', step: 'a tighter contract is refused with the engine’s reason, and the content stays' },
      { test: 'tests/e2e/slot-authoring.mjs', kind: 'e2e', step: 'removing the slot while Home fills it reviews where, and Go to placement leaves the studio with the card selected' },
      { test: 'tests/e2e/slot-authoring.mjs', kind: 'e2e', step: 'Remove slot and its content takes both in one change, and its Undo puts both back' },
      { test: 'tests/unit/removal-review.test.ts', kind: 'unit' },
      { test: 'tests/unit/slot-authoring.test.ts', kind: 'unit' },
      { test: 'tests/unit/slot-contracts.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.turn-into-slot',
    area: 'components',
    intent: 'Turn a container in my component into a slot, keeping what each placement shows',
    start: 'Blank site, a Split component placed twice with different content in its Side column, open in Component Studio',
    routes: ['item:turn-into-slot:<data>', 'inspector:More actions › Turn into slot…', 'panel:Layers › Turn into slot…', 'dialog:Turn into slot'],
    outcome: 'The dialog names the slot after the container; moving the content leaves each placement its own in one change, or the slot is left empty; one Undo puts the design and the pages back; a container that holds a slot, or can’t safely hold one, is offered unavailable with the reason; on the page each placement shows the empty slot and takes a drop',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/turn-into-slot.mjs', kind: 'e2e', step: 'the Inspector turns the Side column into a slot, each placement keeping its own hours, in one change' },
      { test: 'tests/e2e/turn-into-slot.mjs', kind: 'e2e', step: 'one Undo puts the column’s content back in the design, and takes it off the page' },
      { test: 'tests/e2e/turn-into-slot.mjs', kind: 'e2e', step: 'Layers turns it into an empty slot instead, and then offers it no more, saying why' },
      { test: 'tests/e2e/turn-into-slot.mjs', kind: 'e2e', step: 'on the page, both Splits show the empty slot at once, and a Paragraph dragged onto one lands in it alone' },
      { test: 'tests/unit/turn-into-slot.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.placed-slots',
    area: 'components',
    intent: 'See and fill the slots of a component I placed, from the Inspector',
    start: 'Blank site, a card with Media, Actions, Body and Quiet slots placed in a Section, and a component with none',
    routes: ['inspector:Slots', 'inspector:Slots › Add', 'inspector:Slots › content', 'inspector:Slots › Move out', 'inspector:Slots › Clear'],
    outcome: 'The Inspector lists a placement’s slots in the order it declares them, with what each takes and holds; Add offers only what the slot takes and inserts into it alone, and is off with the reason at its limit; what a slot holds is a click away; Move out and Clear are one Undo each; a component with no slots shows no section',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/placed-slots.mjs', kind: 'e2e', step: 'the card lists its slots in the order it declares them, with what each takes and holds' },
      { test: 'tests/e2e/placed-slots.mjs', kind: 'e2e', step: 'Add on Actions offers only what Actions takes, and inserts into it alone, in one change' },
      { test: 'tests/e2e/placed-slots.mjs', kind: 'e2e', step: 'at its limit, Add is off and says why' },
      { test: 'tests/e2e/placed-slots.mjs', kind: 'e2e', step: 'what a slot holds is a click away, each named as Layers names it' },
      { test: 'tests/e2e/placed-slots.mjs', kind: 'e2e', step: 'Move out puts what Actions holds just after the card, in one Undo' },
      { test: 'tests/e2e/placed-slots.mjs', kind: 'e2e', step: 'Clear deletes what Actions holds, in one Undo' },
      { test: 'tests/e2e/placed-slots.mjs', kind: 'e2e', step: 'a component with no slots shows no Slots section' },
      { test: 'tests/unit/slot-overview.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.conditions',
    area: 'components',
    intent: 'Show or hide part of a component depending on its content',
    start: 'Business site, the Services grid edited everywhere',
    routes: ['inspector:Show when', 'inspector:Hide when', 'inspector:Hide when empty'],
    outcome: 'Rules set in the Inspector are marked in Layers, followed by the preview as values change, and undone and redone; a layer the preview shows nowhere stays selectable',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/conditions.mjs', kind: 'e2e', step: 'show the icon only on one card' },
      { test: 'tests/e2e/conditions.mjs', kind: 'e2e', step: 'the preview follows a placement’s values' },
      { test: 'tests/e2e/conditions.mjs', kind: 'e2e', step: 'undo and redo' },
      { test: 'tests/unit/conditions.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'components.required',
    area: 'components',
    intent: 'Require a value on every placement of a component, and fill in what one is missing',
    start: 'Blank site, a project component placed twice, one placement’s label cleared, edited everywhere',
    routes: ['inspector:Properties › Required', 'inspector:Content', 'dialog:Project health › Go to field'],
    outcome: 'The switch makes the property required in one Undo and says how many placements are missing it, never refusing them; a field the component requires says so, and clearing a filled one is refused at the field with the engine’s message, keeping its value and showing no toast; Project health goes to the field of a placement still missing it',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/required-properties.mjs', kind: 'e2e', step: 'Edit everywhere: turn Required on for Monthly label' },
      { test: 'tests/e2e/required-properties.mjs', kind: 'e2e', step: 'clearing a filled label is refused at the field, which keeps it' },
      { test: 'tests/e2e/required-properties.mjs', kind: 'e2e', step: 'Project health lists the placement missing it and goes to its field' },
      { test: 'tests/e2e/required-properties.mjs', kind: 'e2e', step: 'one Undo takes the rule and the finding away' },
      { test: 'tests/unit/required-fields.test.ts', kind: 'unit' },
      { test: 'tests/unit/required-props.test.ts', kind: 'unit' },
      { test: 'tests/unit/component-contract.test.ts', kind: 'unit' }
    ]
  },
  // ---- code ----
  {
    id: 'code.create',
    area: 'code',
    intent: 'Write a component in code',
    start: 'Blank site, Developer mode on, Insert showing',
    routes: ['panel:Insert › New code component', 'dialog:Code component › Properties', 'dialog:Code component › Save'],
    outcome: 'The properties tab edits the schema before creating; saved, the component is inserted and rendered; a keyboard author keeps the undo history; Undo removes the placement, then the component and its file',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'the properties tab edits the schema before creating' },
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'save, insert and render' },
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'undo removes the placement, then the component and its file' },
      { test: 'tests/unit/code.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'code.diagnostics',
    area: 'code',
    intent: 'See what is wrong with my code and fix it',
    start: 'A code component with a syntax error being written',
    routes: ['dialog:Code component › Diagnostics'],
    outcome: 'The syntax error shows as a diagnostic before saving; the code checks reject unknown packages, raw HTML and eval, and a fixed component is accepted only when it passes them',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'a syntax error shows a diagnostic' },
      { test: 'tests/unit/code.test.ts', kind: 'unit', step: 'returns a fixed component only when it passes the checks' },
      { test: 'tests/unit/build-diagnostics.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'The code-fixing agent runs only with LIVE_FIX=1 and a real key (code.mjs), so no routine run proves the AI fix', owner: 'code', issue: 130 }]
  },
  {
    id: 'code.edit',
    area: 'code',
    intent: 'Change the source of a code component, or turn a visual one into code',
    start: 'Blank site with a placed code component, Developer mode on',
    routes: ['item:Inspector:Edit code', 'item:Insert:Edit code', 'inspector:Component › Edit code', 'item:Inspector:Convert to code'],
    outcome: 'The source editor saves an edited schema; a schema changed under unsaved rows is not overwritten; a rename is saved only onto the project it was made against; Convert to code makes a code component whose properties stay editable',
    scenario: 'Blank starter · none; unit fixtures',
    proof: [
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'the source editor saves an edited schema' },
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'a schema that changes under unsaved rows is not overwritten by them (#103)' },
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'a rename is saved only onto the project it was made against' },
      { test: 'tests/unit/engine.test.ts', kind: 'unit' }
    ],
    gaps: [
      { missing: 'code.mjs opens the source from the component section’s Edit code button; Edit code in the Inspector’s actions menu and in Insert’s tile menu is never chosen', owner: 'code' },
      { missing: 'No e2e script chooses Convert to code', owner: 'code' }
    ]
  },
  {
    id: 'code.source',
    area: 'code',
    intent: 'Read the source of a theme component, or the Svelte a page generates',
    start: 'Business site, Developer mode on',
    routes: ['item:Inspector:View source', 'item:Pages:View generated source…'],
    outcome: 'The source view opens on the component (screenshot only)',
    scenario: 'Business starter · none',
    proof: [{ test: 'tests/e2e/tour.mjs', kind: 'design', step: 'source view (Developer mode)' }],
    gaps: [
      { missing: 'Nothing asserts what View source shows; tour.mjs only photographs it', owner: 'code' },
      { missing: 'No test chooses View generated source… or checks what it shows', owner: 'code' }
    ]
  },
  {
    id: 'code.slots',
    area: 'code',
    intent: 'Let a code component take content and expose parts to style',
    start: 'Blank site, a code component that marks a part and shows a slot',
    routes: ['canvas:click the marked part', 'canvas:+ inside the slot'],
    outcome: 'Both are declared when it is created; content inserted on the canvas goes into the slot; a background set in the Inspector reaches the marked element; neither the website’s build nor the source export carries a marker while the editable project keeps them',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/code-slots.mjs', kind: 'e2e', step: 'a Stack and a Button inserted on the canvas go into the code component’s slot' },
      { test: 'tests/e2e/code-slots.mjs', kind: 'e2e', step: 'a background set in the Inspector reaches the marked element' },
      { test: 'tests/e2e/code-slots.mjs', kind: 'e2e', step: 'neither export carries a marker; the editable project keeps them' },
      { test: 'tests/unit/code-parts.test.ts', kind: 'unit' }
    ]
  },
  // ---- assets ----
  {
    id: 'assets.import',
    area: 'assets',
    intent: 'Add my photos to the library, straight off my phone too',
    start: 'A project open, Assets showing',
    routes: ['tab:assets', 'panel:Assets › Add images', 'dialog:Import review', 'inspector:Image › Choose image › Import'],
    outcome: 'The images are in the library and the media folder, and the window keeps answering while many large photos import; Add images offers HEIC and the review says what each file becomes; each becomes a web-sized copy, placed at once from the image picker, and ships the right way up',
    scenario: 'welcome · none; Blank starter · none',
    proof: [
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'an image staged in the session’s imports folder is added through Assets' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'fixture: one image in the library, added through Assets' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'import them while the window keeps asking the main process for something' },
      { test: 'tests/unit/photo-import.test.ts', kind: 'unit' },
      { test: 'tests/unit/media.test.ts', kind: 'unit' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'phone photos: Add images offers HEIC, and the review says what each file of a mixed batch becomes' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'Assets: a large library image gets a web-sized copy without leaving the builder' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'the static export ships the placed photo the right way up, with its responsive copies' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'a rotated, geotagged phone photo placed on Home' },
      { test: 'tests/unit/photo-metadata.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assets.responsive',
    area: 'assets',
    intent: 'Have my photos served at the right size on each screen',
    start: 'A project with imported or starter photos',
    routes: ['panel:Assets › Add images'],
    outcome: 'Each picture has its responsive copies, made in the media worker (in the packaged app too) and served by the preview; the Assets grid and the image picker load the small copies',
    scenario: 'Blank and Business starters · none',
    builds: ['dev', 'packaged'],
    proof: [
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'each picture has its responsive copies, served by the preview under the development frame policy' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: '#223: the Assets grid and the image picker load the small copies, not the originals' },
      { test: 'tests/e2e/packaged.mjs', kind: 'packaged' },
      { test: 'tests/unit/image-variants.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assets.place',
    area: 'assets',
    intent: 'Put a library image on the page',
    start: 'Business site, an image element selected',
    routes: ['inspector:Image › Choose image', 'panel:Assets › image › Use'],
    outcome: 'A library image already used in the Gallery is placed again from Assets; the picker’s Import reviews a new photo and places it at once',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'place a library image already used in the Gallery from Assets (#13)' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'the inspector image picker: Choose image → Import reviews the photo and places it at once' },
      { test: 'tests/unit/image-placement.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assets.drag',
    area: 'assets',
    intent: 'Drag an image from Assets onto the page',
    start: 'Business site Home with the Split hero’s image emptied',
    routes: ['canvas:drag Assets tile'],
    outcome: 'Held over the hero, the empty image is outlined and the strip says what a drop does; released, it takes the picture with its suggested alt text as one change that one Undo empties; between sections a new Image goes in a Section of its own; Escape cancels',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/asset-drag.mjs', kind: 'e2e', step: 'held over the placeholder, the placeholder is outlined; released, it takes the picture as one change' },
      { test: 'tests/e2e/asset-drag.mjs', kind: 'e2e', step: 'Escape cancels' },
      { test: 'tests/e2e/asset-drag.mjs', kind: 'e2e', step: 'between two sections with no empty image, a line shows where a new Image goes' },
      { test: 'tests/unit/image-drop.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assets.cleanup',
    area: 'assets',
    intent: 'See where an image is used, and remove the ones I no longer use',
    start: 'A site with images placed in a post and others no page uses',
    routes: ['panel:Assets › Remove', 'panel:Assets › Free up space', 'panel:Assets › image › Uses'],
    outcome: 'Assets lists a post as a use of its picture and opens the post at it; removing unused images keeps the files for Undo and says so; Free up space shows what it deletes and which undo steps go, then frees it; a deleted image is never exported',
    scenario: 'Blank and Business starters · none',
    proof: [
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'remove every unused image: the files stay, and the Assets panel says they are kept for Undo' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'Free up space shows what it deletes and which steps go, then frees it' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'an image that was imported and then deleted' },
      { test: 'tests/unit/asset-cleanup.test.ts', kind: 'unit' },
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'Assets lists the picture as a use, and opens the post at it' },
      { test: 'tests/unit/asset-uses.test.ts', kind: 'unit' },
      { test: 'tests/unit/assets-show-use.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assets.fonts',
    area: 'assets',
    intent: 'Import my own font files, and remove one safely',
    start: 'Blank site, Assets showing',
    routes: ['panel:Assets › Add fonts', 'panel:Assets › font › Remove'],
    outcome: 'Each file says its style, weight and alphabet and shows itself in its own face; removing a file the site uses says what changes first and does what the author chose; Undo brings it back; Chromium paints the imported files',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/fonts.mjs', kind: 'e2e', step: 'import Latin upright and italic Lora' },
      { test: 'tests/e2e/fonts.mjs', kind: 'e2e', step: 'Assets lists each family once, says where it is used, and names each file by style, alphabet and weights in its own face' },
      { test: 'tests/e2e/fonts.mjs', kind: 'e2e', step: 'removing the upright body file says body text would turn italic, and Cancel keeps it' },
      { test: 'tests/unit/fonts.test.ts', kind: 'unit' }
    ]
  },
  // ---- find ----
  {
    id: 'find.replace',
    area: 'find',
    intent: 'Replace an email address or phone number everywhere on the site',
    start: 'Business site with the starter’s sample contact details',
    routes: ['key:f', 'command:find', 'command:find:all', 'dialog:Find and replace › Replace'],
    outcome: 'Every place the email appears is changed at once, and the number both as written and as dialled; the exported Contact page sends enquiries to the new details',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'Replace everywhere changes the email in all five places, and the number as written and as dialled' },
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'the exported Contact page sends enquiries to the new details' },
      { test: 'tests/unit/find-content.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Find and replace is reached only from the Export dialog’s sample review; no e2e opens it with Shift+Cmd/Ctrl+F or from the command menu', owner: 'find' }]
  },
  {
    id: 'find.entries',
    area: 'find',
    intent: 'Rename a term across the pages and the collection entries’ titles and excerpts',
    start: 'Site with a blog and a collection synced from an external source',
    routes: ['key:f', 'command:find', 'dialog:Find and replace › Replace'],
    outcome: 'Local entries’ titles and excerpts change with the pages in one step that undoes as one; a synced collection’s matches are listed as read-only and left as they are',
    scenario: 'unit fixtures · none',
    proof: [
      { test: 'tests/unit/find-content.test.ts', kind: 'unit', step: 'replaces in pages and entries in one batch, with one edit per entry, and finds none left' },
      { test: 'tests/unit/find-content.test.ts', kind: 'unit', step: 'lists a synced collection’s entries as read-only results, and never changes them' },
      { test: 'tests/unit/find-content.test.ts', kind: 'unit', step: 'changes a page and several entries in one step that undoes and redoes as one' }
    ],
    gaps: [{ missing: 'No e2e script replaces in an entry from the dialog or opens an entry match in the writer', owner: 'find' }]
  },
  {
    id: 'find.command',
    area: 'find',
    intent: 'Find words or a section already on the site by typing',
    start: 'Business site, the command menu open',
    routes: ['key:k', 'command:find:*', 'command:sec:*:*', 'command:sec:more'],
    outcome: 'The command menu lists the sections already placed and the words and links that match, each with where it is',
    scenario: 'unit fixtures · none',
    proof: [{ test: 'tests/unit/find-content.test.ts', kind: 'unit', step: 'lists the sections already placed, so a search reaches the existing one' }],
    gaps: [{ missing: 'No e2e script chooses an On the site result, a word match or Show more sections in the command menu', owner: 'find' }]
  },
  {
    id: 'find.site-search',
    area: 'find',
    intent: 'Give visitors a search box for the site',
    start: 'Business site with a nested page holding Site search',
    routes: ['panel:Insert › Site search'],
    outcome: 'The exported proof searches its pages from a nested address and goes to the one found; a renamed page is found at its new address and a removed or hidden one is not',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#246: the first proof searches its pages from a nested address and goes to the one found' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#246: the second proof finds the renamed page at its new address, and neither the removed nor the hidden one' },
      { test: 'tests/unit/site-search.test.ts', kind: 'unit' },
      { test: 'tests/unit/site-search-visitor.test.ts', kind: 'unit' }
    ]
  },
  // ---- history ----
  {
    id: 'history.undo',
    area: 'history',
    intent: 'Undo the last change, and redo it',
    start: 'Business site after an edit',
    routes: ['key:z', 'key:y', 'menu:Edit > Undo', 'menu:Edit > Redo', 'command:undo', 'command:redo', 'toolbar:Undo', 'toolbar:Redo'],
    outcome: 'Layers, the canvas and an Inspector select undo the project one step at a time from the keyboard and from Edit › Undo; the Edit menu carries the standard keys (Ctrl+Y for Redo on Windows)',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/undo.mjs', kind: 'e2e', step: 'the Edit menu keeps Undo and Redo with the standard keys' },
      { test: 'tests/e2e/undo.mjs', kind: 'e2e', step: 'Layers undoes the project from the keyboard and the Edit menu' },
      { test: 'tests/e2e/undo.mjs', kind: 'e2e', step: 'the canvas in Edit mode undoes the project from the keyboard and the Edit menu' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'keyboard Undo and Redo from a Layers row move the project one step each' },
      { test: 'tests/unit/history-routing.test.ts', kind: 'unit' },
      { test: 'tests/unit/contextual-undo.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Undo and Redo from the command menu are never chosen by a test', owner: 'history' }]
  },
  {
    id: 'history.field-undo',
    area: 'history',
    intent: 'Undo my typing in a field without undoing the site',
    start: 'Business site with a Contact form, typing in a field',
    routes: ['key:z', 'menu:Edit > Undo'],
    outcome: 'A visitor’s field in Preview, a form field on the canvas, inline copy being edited, an Inspector field and a dialog’s text field keep their own text history and never move the project',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/undo.mjs', kind: 'e2e', step: 'Undo in Preview never reaches the project, whatever on the page has focus' },
      { test: 'tests/e2e/undo.mjs', kind: 'e2e', step: 'inline site copy keeps its own history while it is being edited' },
      { test: 'tests/e2e/undo.mjs', kind: 'e2e', step: 'an inspector field keeps its own history' },
      { test: 'tests/e2e/undo.mjs', kind: 'e2e', step: 'a dialog’s text field keeps its own history' }
    ]
  },
  {
    id: 'history.steps',
    area: 'history',
    intent: 'Go back several changes at once',
    start: 'Business site after edits made with the editor’s own controls',
    routes: ['command:history', 'item:Toolbar:History…'],
    outcome: 'History lists each change by what it did, to which element, on which page; the keyboard moves between changes without changing anything, Enter steps back several in one change, a click redoes several, and what was undone can be redone until a new change',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/history-steps.mjs', kind: 'e2e', step: 'History opens from the keyboard where History stands now' },
      { test: 'tests/e2e/history-steps.mjs', kind: 'e2e', step: 'the keyboard moves between changes without changing anything, and Enter steps back several' },
      { test: 'tests/e2e/history-steps.mjs', kind: 'e2e', step: 'a click redoes several forward in one step' },
      { test: 'tests/e2e/list-history.mjs', kind: 'e2e', step: 'the entries are told apart' },
      { test: 'tests/unit/history-steps.test.ts', kind: 'unit' },
      { test: 'tests/unit/edit-labels.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'History… from the command menu is never chosen by a test', owner: 'history' }]
  },
  {
    id: 'history.versions',
    area: 'history',
    intent: 'Save a named version of the site and go back to it',
    start: 'Business site open',
    routes: ['item:Toolbar:Save version…', 'command:save-version', 'dialog:History › Versions'],
    outcome: 'A named version is saved; restoring shows what it would change, keeps the replaced work as a version of its own, and the notification’s Undo takes the restore back; the list survives a reopen; a version is deleted only after confirming',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/versions.mjs', kind: 'e2e', step: 'save a version from the project menu' },
      { test: 'tests/e2e/versions.mjs', kind: 'e2e', step: 'restore it: the replaced work is kept, and Undo takes the restore back' },
      { test: 'tests/e2e/versions.mjs', kind: 'e2e', step: 'the versions are still there after closing and reopening the project' },
      { test: 'tests/e2e/versions.mjs', kind: 'e2e', step: 'delete a version once the author confirms' },
      { test: 'tests/unit/saved-versions.test.ts', kind: 'unit' },
      { test: 'tests/unit/restore.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Save a version of the site… from the command menu is never chosen by a test', owner: 'history' }]
  },
  {
    id: 'history.read-only',
    area: 'history',
    intent: 'Look at a project another app is editing, or one from a newer Builder, without changing it',
    start: 'A Business project locked by another app, or saved by a newer version',
    routes: ['welcome:Open project', 'status:Read-only › Unlock'],
    outcome: 'The locked project previews from a private copy that follows what the other app writes; exports and Duplicate are refused; closing or quitting removes the copy and leaves the folder byte-identical; a newer project shows no preview; Unlock is the only path that changes the folder',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/read-only.mjs', kind: 'e2e', step: 'a project another app is editing renders from a private copy' },
      { test: 'tests/e2e/read-only.mjs', kind: 'e2e', step: 'exports and Duplicate are refused' },
      { test: 'tests/e2e/read-only.mjs', kind: 'e2e', step: 'closing removes the copy and leaves the folder byte-identical' },
      { test: 'tests/e2e/read-only.mjs', kind: 'e2e', step: 'Unlock is the one path that changes the folder' },
      { test: 'tests/unit/read-only-controller.test.ts', kind: 'unit' },
      { test: 'tests/unit/read-only-open.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'history.conflict',
    area: 'history',
    intent: 'Keep my work when a project file is changed outside Builder',
    start: 'A project open while another tool edits its documents',
    routes: ['status:File conflict notice'],
    outcome: 'A newer on-disk edit is never overwritten and is reported as a conflict; an externally edited generated file is kept; a design’s own file edited outside the app converts into a code component only with Developer mode and code that passes the checks, keeping the edited file under Saved copies; the toolbar fits the conflict notice at the minimum window size',
    scenario: 'unit fixtures · none',
    proof: [
      { test: 'tests/unit/session.test.ts', kind: 'unit', step: 'refuses to overwrite a newer on-disk edit' },
      { test: 'tests/unit/session-recovery.test.ts', kind: 'unit', step: 'canonical conflicts (spec 18.5)' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'the same with a file conflict notice, the widest save state' },
      { test: 'tests/e2e/convert-edited.mjs', kind: 'e2e', step: 'only the design file’s row offers the conversion, and without Developer mode it says why' },
      { test: 'tests/e2e/convert-edited.mjs', kind: 'e2e', step: 'with Developer mode on, an edited file that fails the code checks is refused on its row, and nothing changes' },
      { test: 'tests/e2e/convert-edited.mjs', kind: 'e2e', step: 'put right, it converts: the row goes, the preview shows the edited hero, and the edited file is under Saved copies' }
    ],
    gaps: [{ missing: 'No e2e script edits a document outside the app while it is open and resolves the conflict the editor reports', owner: 'history' }]
  },
  // ---- preview ----
  {
    id: 'preview.mode',
    area: 'preview',
    intent: 'See the page as visitors will',
    start: 'Business site Home in Edit',
    routes: ['toolbar:Preview', 'command:preview', 'preview:Back to editing'],
    outcome: 'Preview shows the page with no editor frames, placeholders or Add buttons; the snapshot tells visitor mode apart from a preview still loading; back in Edit the last selection is selected again',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/resume-place.mjs', kind: 'e2e', step: 'Preview and Edit from the toolbar do the same' },
      { test: 'tests/e2e/empty-layout.mjs', kind: 'e2e', step: 'Preview shows the Grid as visitors get it' },
      { test: 'tests/e2e/snapshot.mjs', kind: 'driver', step: 'visitor mode is told apart from a preview still loading' },
      { test: 'tests/e2e/view-index.mjs', kind: 'e2e', step: 'Back to editing shows Home again, not the index under its name' },
      { test: 'tests/unit/preview-stage.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Switch to preview from the command menu is never chosen by a test', owner: 'preview' }]
  },
  {
    id: 'preview.widths',
    area: 'preview',
    intent: 'Check the page at phone and tablet widths',
    start: 'Business site Home',
    routes: ['toolbar:Phone', 'toolbar:Width', 'canvas:frame edge', 'command:desktop', 'command:tablet', 'command:phone'],
    outcome: 'The frame takes the chosen width from the toolbar, the command menu, a dragged edge or arrow keys, remembers it, and keeps the selected section in view; none of it changes the project',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'the preview width and zoom are remembered wherever they are chosen' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'the preview frame resized by dragging its edge, without touching the project' },
      { test: 'tests/e2e/keep-selection.mjs', kind: 'e2e', step: 'switching to Phone keeps Gallery in view, and so does switching back to Desktop' }
    ],
    gaps: [{ missing: 'Preview at desktop width and Preview at phone width from the command menu are never chosen (layout.mjs chooses the tablet one)', owner: 'preview' }]
  },
  {
    id: 'preview.zoom',
    area: 'preview',
    intent: 'Zoom the canvas in or out',
    start: 'Business site open',
    routes: ['toolbar:Zoom', 'item:Toolbar:Fit to window', 'item:Toolbar:*%'],
    outcome: 'The zoom menu offers Fit to window and fixed levels with the current one checked; a level draws the preview at that scale and is remembered; in a zoomed-in interface Zoom moves into a labelled More menu',
    scenario: 'Blank and Business starters · none',
    proof: [
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'a zoomed-in interface moves Zoom and Settings into a labelled More menu' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'the preview width and zoom are remembered wherever they are chosen' }
    ]
  },
  {
    id: 'preview.journey',
    area: 'preview',
    intent: 'Click through the site as a visitor, and back',
    start: 'Business site in Preview, starting on Home',
    routes: ['preview:link', 'preview:Back', 'preview:Forward', 'preview:Address'],
    outcome: 'The pill shows the address with its #fragment; Back and Forward step through the visits, a section jump included, and bring each page back where the visitor left it; a new link after Back drops Forward; the browser’s Back key never touches the project’s Undo',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/preview-history.mjs', kind: 'e2e', step: 'Back to About, where the visitor left it, and Forward again' },
      { test: 'tests/e2e/preview-history.mjs', kind: 'e2e', step: 'a new link after Back drops Forward' },
      { test: 'tests/e2e/preview-history.mjs', kind: 'e2e', step: 'the Back and Forward keys step once each, from the page' },
      { test: 'tests/e2e/child-pages.mjs', kind: 'e2e', step: 'in Preview, the editor follows a visitor to the page, and back' },
      { test: 'tests/unit/preview-history.test.ts', kind: 'unit' },
      { test: 'tests/unit/preview-journey.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'preview.resume',
    area: 'preview',
    intent: 'Come back to where I was editing',
    start: 'Business site Home, the last call to action selected',
    routes: ['preview:Back to editing', 'panel:Pages › page row', 'welcome:Recent projects › card'],
    outcome: 'Back from Preview, the call to action is selected again and the page stays where the visitor scrolled it; returning to Home from the page list, and reopening the project, select it again and bring it into view; a visitor’s jump or link leaves nothing selected; none of it is a change to the site',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/resume-place.mjs', kind: 'e2e', step: 'Preview, scroll as a visitor, Back to editing' },
      { test: 'tests/e2e/resume-place.mjs', kind: 'e2e', step: 'returning to Home from the page list selects the call to action again, in view' },
      { test: 'tests/e2e/resume-place.mjs', kind: 'e2e', step: 'reopening the project opens Home at the call to action, in view' },
      { test: 'tests/unit/workspace-state.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'The reopen is made through the project API, not from Welcome’s Recent projects card', owner: 'preview' }]
  },
  {
    id: 'preview.live',
    area: 'preview',
    intent: 'See my change in the canvas straight away, the same as the published site',
    start: 'Business site Home, a server-rendered and hydrated page',
    routes: ['inspector:Content › field', 'item:Inspector:Edit everywhere…'],
    outcome: 'After a change to a component alone and then to the page or component that places it, the canvas shows one copy of the page through hot updates, the same as a full reload and the static export',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/hot-update.mjs', kind: 'e2e', step: 'a change to the hero component alone' },
      { test: 'tests/e2e/hot-update.mjs', kind: 'e2e', step: 'a full reload of the canvas shows the same page' },
      { test: 'tests/e2e/hot-update.mjs', kind: 'e2e', step: 'the static export shows the same page' }
    ]
  },
  {
    id: 'preview.error-recovery',
    area: 'preview',
    intent: 'When the page breaks after a change, undo that change or open the component that threw',
    start: 'Business site Home, the page reporting an error on the canvas',
    routes: ['canvas:Page problem › Revert', 'canvas:Page problem › Open source', 'canvas:Page problem › Try again'],
    outcome: 'Revert is offered only for the one change made since the page last worked and, used, undoes it and brings the page back while keeping earlier edits; Open source opens the component the error names; neither is offered when the cause is unknown',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/preview-error.mjs', kind: 'e2e', step: 'the first edit after the page opens, followed by an error, offers to revert it' },
      { test: 'tests/e2e/preview-error.mjs', kind: 'e2e', step: 'an error with no edit before it offers no Revert, and Open source opens the generated component read only' },
      { test: 'tests/e2e/preview-error.mjs', kind: 'e2e', step: 'an error after an edit offers to revert it, and Revert brings the page back without it, keeping the edit before' },
      { test: 'tests/unit/preview-error.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'preview.packaged',
    area: 'preview',
    intent: 'Preview the site in the installed app',
    start: 'The packaged app with a Business project created',
    routes: ['toolbar:Preview'],
    outcome: 'The preview’s pages and static files are served with the packaged frame policy and their content types',
    scenario: 'Business starter · none',
    builds: ['dev', 'packaged'],
    proof: [
      { test: 'tests/e2e/packaged.mjs', kind: 'packaged' },
      { test: 'tests/e2e/import.mjs', kind: 'e2e', step: 'served by the preview under the development frame policy' }
    ]
  },
  {
    id: 'preview.live-session',
    area: 'preview',
    intent: 'Share the project live: start a session, send the link, let people in as viewers or collaborators, and manage who is in it until it ends',
    start: 'A project open, no live session, the relay in its local simulator',
    routes: ['toolbar:Share', 'dialog:Share a live session › Session length', 'dialog:Share a live session › Start live session', 'dialog:Live session › Copy', 'status:Join requests › Admit as Viewer', 'status:Join requests › Admit as Collaborator', 'dialog:Live session › Decline', 'dialog:Live session › Role', 'dialog:Live session › Access', 'dialog:Live session › Remove', 'dialog:Live session › Lock room', 'dialog:Live session › Extend', 'dialog:Live session › Allow AI editing', 'item:SharePopover:<data>', 'dialog:Live session › End session', 'dialog:Live session › Escape'],
    outcome: 'The invite link points at the configured relay and is copied on start and on Copy; a waiting guest is announced and is let in with the chosen role, or declined; role, a guest’s own end of access, the lock, an extension and a removal reach the guests; a removed guest’s socket closes and its preview cookie is refused at once; Allow AI editing lets a collaborator’s requests run on the host’s AI, and turning it off stops one running and refuses the next; a dropped relay connection is taken back with the session’s signed key, every admitted guest still in the room; guests follow the host’s page and width; ending the session, or closing the project, ends it for every guest and leaves Share as it was',
    scenario: 'business · none · relay simulator',
    proof: [
      { test: L_SHARE, kind: 'e2e', step: 'Share starts a live session and copies its invite link' },
      { test: L_SHARE, kind: 'e2e', step: 'a guest waiting is announced, and admitted from the notice' },
      { test: L_SHARE, kind: 'e2e', step: 'guests follow the host’s page and width' },
      { test: L_SHARE, kind: 'e2e', step: 'the popover admits and declines, and manages the roster' },
      { test: L_SHARE, kind: 'e2e', step: 'locking turns new guests away and keeps those in' },
      { test: L_SHARE, kind: 'e2e', step: 'extending moves the end later' },
      { test: L_SHARE, kind: 'e2e', step: 'removing a guest' },
      { test: L_SHARE, kind: 'e2e', step: 'ending the session' },
      { test: L_SHARE, kind: 'e2e', step: 'closing the project ends a running session for everyone' },
      { test: L_VIEWER, kind: 'e2e', step: 'before admission, the room’s preview origin refuses the browser' },
      { test: L_VIEWER, kind: 'e2e', step: 'the browser asks to join under a name, and the host admits it as a viewer' },
      { test: L_VIEWER, kind: 'e2e', step: 'a heading the host edits updates in the browser without a reload' },
      { test: L_VIEWER, kind: 'e2e', step: 'a spotlight the viewer points shows on the host’s canvas' },
      { test: L_VIEWER, kind: 'e2e', step: 'a note the viewer pins shows to the host, on the page the viewer is on' },
      { test: L_VIEWER, kind: 'e2e', step: 'one browser profile let in to two rooms cannot read either room’s preview from the other’s origin' },
      { test: L_RECOVER, kind: 'e2e', step: 'with Allow AI editing on, the collaborator’s request runs on the host’s AI and lands as hers' },
      { test: L_RECOVER, kind: 'e2e', step: 'turning AI editing off stops the request the host is running, and the host refuses the next' },
      { test: L_RECOVER, kind: 'e2e', step: 'the host’s connection drops, and it takes the room back with its signed key, every guest still in it' },
      { test: L_RECOVER, kind: 'e2e', step: 'a removed guest’s socket closes and its preview origin refuses it straight away' },
      { test: 'tests/unit/live-share.test.ts', kind: 'unit' },
      { test: 'tests/unit/live-ai.test.ts', kind: 'unit' },
      { test: 'tests/unit/live-host-relay.test.ts', kind: 'unit', step: 'reaches a guest let in later, and every admitted guest as the host moves' }
    ],
    gaps: [{ missing: 'A relay connection that stays down past its budget, ending the session, is proven only below the editor, in tests/unit/live-host-relay.test.ts', owner: 'preview' }]
  },
  {
    id: 'preview.remote-shell',
    area: 'preview',
    intent: 'Join someone else’s live session from my own copy of Builder, and edit their site with them, or watch it, until I leave or the session ends',
    start: 'Welcome or a project of my own open, a host’s invite link, the relay in its local simulator',
    routes: ['welcome:Join live session', 'menu:File > Join Live Session…', 'dialog:Join live session › Ask to join', 'dialog:Join live session › Stop asking', 'toolbar:Live session', 'item:RemoteSession:*: *', 'item:RemoteSession:Leave session…', 'item:Toolbar:Leave live session…', 'toolbar:Leave session', 'chat:Ask the host’s AI', 'chat:Send'],
    outcome:
      'The host is asked under the name given, and once it admits the guest the editor shows the host’s project and its preview; a collaborator’s selection is outlined on the host’s canvas; its edits land on the host’s disk as the guest’s own History steps, come back to the guest and reach the room’s viewers; it resolves the room’s pinned notes; once the host allows it, its AI requests run on the host’s AI and their changes are the guest’s History steps, and one the host stops says so; the host refuses a code edit from it, and the remote shell blocks Export; a viewer, or a guest made one, cannot edit; it stays in the room while the host’s connection drops and comes back; leaving, being removed, an expiry or the host ending the session puts the editor back on Welcome, saying why, with this computer’s projects as they were',
    scenario: 'blank · none · relay simulator; business · none · relay simulator, two apps',
    proof: [
      { test: L_COLLAB, kind: 'e2e', step: 'the second app joins through the invite link and waits for the host' },
      { test: L_COLLAB, kind: 'e2e', step: 'the host admits it and makes it a Collaborator' },
      { test: L_COLLAB, kind: 'e2e', step: 'the collaborator’s selection shows as an outline on the host’s canvas' },
      { test: L_COLLAB, kind: 'e2e', step: 'the collaborator’s visual edit is written to the host’s disk, shows in its History and reaches the viewer' },
      { test: L_COLLAB, kind: 'e2e', step: 'the collaborator resolves a note pinned in the room' },
      { test: L_COLLAB, kind: 'e2e', step: 'the host refuses the collaborator’s code edit, and the remote shell blocks Export' },
      { test: L_COLLAB, kind: 'e2e', step: 'made a Viewer, the collaborator’s next edit is refused at once' },
      { test: L_RECOVER, kind: 'e2e', step: 'the host starts a live session, and the second app joins as a Collaborator' },
      { test: L_RECOVER, kind: 'e2e', step: 'with Allow AI editing on, the collaborator’s request runs on the host’s AI and lands as hers' },
      { test: L_RECOVER, kind: 'e2e', step: 'turning AI editing off stops the request the host is running, and the host refuses the next' },
      { test: L_RECOVER, kind: 'e2e', step: 'the host’s connection drops, and it takes the room back with its signed key, every guest still in it' },
      { test: L_RECOVER, kind: 'e2e', step: 'ending the session sends the second app back to Welcome, saying why' },
      { test: 'tests/unit/live-remote-shell.test.ts', kind: 'unit', step: 'joins as a collaborator, shows the host’s project and preview, and edits it through the host' },
      { test: 'tests/unit/live-remote-shell.test.ts', kind: 'unit', step: 'ends at once when the host removes the guest, and its preview goes with it' },
      { test: 'tests/unit/live-guest.test.ts', kind: 'unit' },
      { test: 'tests/unit/live-guest-preview.test.ts', kind: 'unit' },
      { test: 'tests/unit/remote-shell-editor.test.ts', kind: 'unit' },
      { test: 'tests/unit/canvas-navigation.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'The second app going back to Welcome when it leaves, is removed or its access expires is proven by unit tests only (leaving and removal in tests/unit/live-remote-shell.test.ts and tests/unit/remote-shell-editor.test.ts, expiry in tests/unit/live-guest.test.ts and tests/unit/relay-expiry.test.ts); the two-app scripts prove it only for the host ending the session', owner: 'preview' }]
  },
  // ---- export ----
  {
    id: 'export.website',
    area: 'export',
    intent: 'Publish the website to a folder',
    start: 'Business site open',
    routes: ['menu:File > Export…', 'command:export', 'key:e', 'toolbar:Export', 'dialog:Export › Website'],
    outcome: 'The exported folder holds the site’s pages with the edits made, the published posts and not the draft, the sitemap, and a branded not-found page; focus stays in the dialog while exporting and lands on the result',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'export through the controller' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'issue 55: keyboard focus stays in the dialog while exporting and lands on the result' },
      { test: 'tests/e2e/outcomes.mjs', kind: 'driver', step: 'the website exported to a folder holds the edit' },
      { test: 'tests/e2e/flows.mjs', kind: 'e2e', step: 'export static' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'a project: Export and Close Project become available and act' },
      { test: 'tests/unit/export.test.ts', kind: 'unit' },
      { test: 'tests/unit/generator.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Cmd/Ctrl+E pressed in the editor and Export from the command menu are never used by a test (menu.mjs checks the File menu item’s accelerator)', owner: 'export' }]
  },
  {
    id: 'export.zip',
    area: 'export',
    intent: 'Hand the editable project to someone as a ZIP file, and find it on disk',
    start: 'Business site with sample images, an earlier ZIP at the chosen path',
    routes: ['menu:File > Export…', 'dialog:Export › Editable project (ZIP)', 'dialog:Replace? › Cancel', 'dialog:Replace? › Replace', 'dialog:Export › Show in folder'],
    outcome: 'The ZIP is written to the chosen place and a recipient who opens it finds the project with its pages and media; over an existing file the system’s Replace? question keeps it when declined and replaces it when accepted; Show in folder is handed to the desktop (recorded, never opened, in a test launch)',
    scenario: 'welcome · none; Business starter · none',
    proof: [
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'File > Export… exports the editable project as a ZIP file' },
      { test: 'tests/e2e/open-zip.mjs', kind: 'e2e', step: 'the sender exports the editable project as a ZIP file' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'ZIP exports' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'exporting over the ZIP file meets the system’s Replace? question: declined, the file is kept as it was' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'accepted, it is replaced' },
      { test: 'tests/unit/headless-desktop.test.ts', kind: 'unit', step: 'over a file that exists, the system’s Replace? question is answered as the answer says, and declined otherwise' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'Show in folder is recorded as the reveal the app asked for, and Finder never opens' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'issue 212: the export dialog still lists what was handed off after it is closed and reopened' }
    ]
  },
  {
    id: 'export.review-sheet',
    area: 'export',
    intent: 'Show a client chosen pages as pictures at desktop and phone widths, in one file they can open from Downloads without Builder, a server or the internet',
    start: 'Business site open, the Export dialog’s Client review pages opened',
    routes: ['menu:File > Export…', 'dialog:Export › Client review pages', 'dialog:Export › Capture page', 'dialog:Export › Save as one file', 'dialog:Export › Client review › Show in folder'],
    outcome:
      'Capturing pictures each chosen page at each width and lists the new edition; saving an edition writes one HTML file holding every picture, the pages’ titles, the widths’ names and the edition ID, with a note that links, menus and forms need a live preview, and the file opens from disk with no network and asks for nothing; a changed or missing picture, a link in the edition, or a place inside the project writes nothing',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/unit/export-modal-actions-browser.test.ts', kind: 'unit', step: 'captures chosen pages and saves an earlier edition as one file from a folded Client review section (#1134)' },
      { test: 'tests/unit/review-edition.test.ts', kind: 'unit', step: 'writes one HTML file with every picture, title, width and the edition ID, where the chooser says, and can show it' },
      { test: 'tests/unit/review-sheet-browser.test.ts', kind: 'unit' },
      { test: 'tests/unit/review-sheet.test.ts', kind: 'unit' },
      { test: 'tests/unit/review-ipc.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'No e2e script captures pages in the built app and saves the sheet through the real chooser; the dialog is proven with a stand-in bridge and the controller with a stand-in for the hidden capture window', owner: 'export' }]
  },
  {
    id: 'export.proofs',
    area: 'export',
    intent: 'Send a client a website proof, then another, without breaking the first',
    start: 'Business site exported once as a proof',
    routes: ['dialog:Export › Website proof'],
    outcome: 'A second proof keeps the first one serving its own files; a proof published in a sub-folder shows the custom not-found page at a nested missing address',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'issue 212: a second website proof keeps the first one serving its own files' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'issue 66: a proof published in a sub-folder shows the custom not-found page at a nested missing address' },
      { test: 'tests/unit/not-found.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'export.failure',
    area: 'export',
    intent: 'Understand why an export failed and try again',
    start: 'Business site with a code component that throws only while the site is built',
    routes: ['dialog:Export › Details', 'dialog:Export › Copy details', 'dialog:Export › Try again'],
    outcome: 'The dialog says what went wrong and where, the technical details can be read and copied, nothing is published, and the export succeeds once the component is fixed; an export to a place it cannot write fails visibly and writes nothing',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/export-failure.mjs', kind: 'e2e', step: 'the export fails, and says why' },
      { test: 'tests/e2e/export-failure.mjs', kind: 'e2e', step: 'the technical details can be read and copied' },
      { test: 'tests/e2e/export-failure.mjs', kind: 'e2e', step: 'fixing the component and exporting again succeeds' },
      { test: 'tests/e2e/outcomes.mjs', kind: 'driver', step: 'an export to a refused place fails visibly, and nothing is written' },
      { test: 'tests/unit/build-failure.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'export.readiness',
    area: 'export',
    intent: 'Know what to fix before the website goes out',
    start: 'Business site with an unconnected contact form and no public URL',
    routes: ['command:health', 'dialog:Export › Go to form', 'dialog:Export › Go to Public URL'],
    outcome: 'Project health and the export dialog name the form and the missing URL, each leading to the field that fixes it, without stopping the export; a real export’s notes say both; once the URL is saved the website is said to need exporting again',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/export-readiness.mjs', kind: 'e2e', step: 'Project health: Go to form opens the form where it is, with its setting focused' },
      { test: 'tests/e2e/export-readiness.mjs', kind: 'e2e', step: 'the export dialog names the form before the export, without stopping it' },
      { test: 'tests/e2e/export-readiness.mjs', kind: 'e2e', step: 'a public URL saved since says the website needs exporting again' },
      { test: 'tests/e2e/seo-health.mjs', kind: 'e2e', step: 'the export dialog counts what to fix before the website goes out, without stopping it, and leads to Project health (#1288)' },
      { test: 'tests/unit/export-readiness.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'export.samples',
    area: 'export',
    intent: 'Make sure no sample text or contact details from the starter go live',
    start: 'Business site with the starter’s contact details, the Export dialog open',
    routes: ['dialog:Export › Show where', 'dialog:Export › Keep it', 'dialog:Export › Replace everywhere'],
    outcome: 'The export dialog reviews the sample details without stopping the export; Show where opens each field; a kept detail is set aside and can be reviewed again; the exported Blank site has no editing directions or sample details',
    scenario: 'Business and Blank starters · none',
    proof: [
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'Business: the Export dialog reviews the sample contact details, and the export stays available' },
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'Show where lists each place, and Open goes to that field in the inspector' },
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'a kept detail can be reviewed again, and kept again' },
      { test: 'tests/e2e/starter-content.mjs', kind: 'e2e', step: 'the exported Blank website has no editing directions or sample details' }
    ]
  },
  {
    id: 'export.clean',
    area: 'export',
    intent: 'Ship a site with nothing of the editor or my credentials in it, that builds without Builder',
    start: 'Business site with a saved API key, private files and deleted images',
    routes: ['menu:File > Export…', 'dialog:Export › Source'],
    outcome: 'The static and source exports are scanned and hold no editor state, credentials, editor markup or deleted images; one made after a live session holds none of its notes, spotlight, live-session or editor code; library images kept for later are only in the editable project; with --build, plain npm ci && npm run build succeeds in the exported source',
    scenario: 'Business starter · none; business · none · relay simulator, two apps',
    proof: [
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'I09: scan the source export' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'I09: scan the static export' },
      { test: L_RECOVER, kind: 'e2e', step: 'an export made after the session holds nothing of it' },
      { test: 'tests/e2e/snapshot.mjs', kind: 'driver', step: 'the projects carry none of the editor’s markers' },
      { test: 'tests/unit/security.test.ts', kind: 'unit' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: 'I07: npm ci && npm run build in the exported source, outside the app' }
    ],
    gaps: [{ missing: 'The clean build runs only with export.mjs --build and the npm registry, so a routine run does not prove it', owner: 'export' }]
  },
  {
    id: 'export.reopen',
    area: 'export',
    intent: 'Close the project, come back later and find it as I left it',
    start: 'Business site after visible edits',
    routes: ['menu:File > Close Project', 'menu:File > Open Project…', 'welcome:Recent projects › card'],
    outcome: 'The edit is in the document on disk and survives Close and Open Project; the assistant’s transcript and preview, page sharing settings and colour formats are as they were left',
    scenario: 'business-v1 · none',
    proof: [
      { test: 'tests/e2e/outcomes.mjs', kind: 'driver', step: 'the edit survives Close Project and Open Project, through a preview held back on the way' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'the project closed and opened again: the transcript and the preview as they were left' },
      { test: 'tests/e2e/page-sharing.mjs', kind: 'e2e', step: 'the project closed and opened again: every page still says the same' },
      { test: 'tests/e2e/colors.mjs', kind: 'e2e', step: 'each format survives closing and reopening the project' }
    ]
  },
  // ---- assistant ----
  {
    id: 'assistant.edit',
    area: 'assistant',
    intent: 'Ask the assistant to change the element I have selected',
    start: 'Business site, the Split hero selected, a scripted model connected',
    routes: ['chat:Message', 'command:ai', 'key:askAi', 'item:Canvas:Ask AI about this', 'item:Layers:Ask AI about this'],
    outcome: 'The composer names the selection; the edit lands on the element that was selected when the message was sent, even if the selection changes mid-run, and is saved in the page document and shown in the preview',
    scenario: 'business-v1 · scripted',
    proof: [
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'a selected element is edited; the target stays the one sent when the selection changes mid-run' },
      { test: 'tests/e2e/local.mjs', kind: 'e2e', step: 'a chat edit through the local model' },
      { test: 'tests/unit/agent.test.ts', kind: 'unit' },
      { test: 'tests/unit/chat-target.test.ts', kind: 'unit' },
      { test: 'tests/unit/driver-assistant.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'The configurable Ask AI shortcut, Ask AI… in the command menu and Ask AI about this in the canvas and Layers menus are never chosen by an e2e script', owner: 'assistant' }]
  },
  {
    id: 'assistant.ask',
    area: 'assistant',
    intent: 'Ask the assistant a question without it changing anything',
    start: 'Business site with its own studio hours, viewed on Home',
    routes: ['chat:Mode', 'item:Chat:Ask', 'item:Chat:Edit', 'chat:Open in inspector', 'item:Chat:<data>'],
    outcome: 'The answer quotes the site and names the Inspector’s path while the site and its history stay unchanged; the editor says the AI is reading and editing goes on; Open in inspector opens the page, selects the element and focuses the field, and says so once the row is gone',
    scenario: 'Business starter · scripted model server',
    proof: [
      { test: 'tests/e2e/ai-ask.mjs', kind: 'e2e', step: 'the composer asks a read-only question' },
      { test: 'tests/e2e/ai-ask.mjs', kind: 'e2e', step: 'the answer quotes the hours and names the Inspector path, with nothing changed' },
      { test: 'tests/e2e/ai-ask.mjs', kind: 'e2e', step: 'Open in inspector opens Contact, selects Contact details, opens Content and Hours, and focuses Value' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'thread A: a read-only question about the page' }
    ]
  },
  {
    id: 'assistant.control',
    area: 'assistant',
    intent: 'Stay in control of a run: approve or decline a wider change, stop it, or undo it',
    start: 'Business site, a run asking to go beyond the selection, or one that made two changes',
    routes: ['chat:Yes, allow changes across the whole site', 'chat:No, only change the selection', 'chat:Undo turn', 'chat:Stop and undo', 'chat:Stop'],
    outcome: 'Declined, the run stays within the selection and still edits it; approved, the wider change lands; Undo turn reverts both changes and the card says so; Stop ends the run stopped and its change is gone',
    scenario: 'business-v1 · scripted',
    proof: [
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'a wider change, declined: the run stays within the selection, and still edits it' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'a wider change, approved: the same change lands' },
      { test: 'tests/unit/composer-scope.test.ts', kind: 'unit' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'Undo turn reverts both changes, and the card says so' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'Stop and undo: the run ends stopped, and its change is gone' },
      { test: 'tests/unit/ai-turn-review.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Stop on a question in Ask mode (the control is named Stop there) is not driven', owner: 'assistant' }]
  },
  {
    id: 'assistant.questions',
    area: 'assistant',
    intent: 'Answer the assistant’s questions, and keep working while it runs',
    start: 'A project, the AI tab open, an interview request sent',
    routes: ['chat:Question › choice', 'chat:Message', 'chat:Conversations', 'panel:right panel tabs'],
    outcome: 'Each question waits above the composer, which becomes the answer box; an empty answer sends nothing; a choice or Enter answers and every exchange stays after reopening; while it reads or waits, the editor says who must act and editing goes on; another thread opens mid-run while the run goes on in its own',
    scenario: 'Blank starter · scripted model server; business-v1 · scripted',
    proof: [
      { test: 'tests/e2e/ai-questions.mjs', kind: 'e2e', step: 'the first question waits above the composer, which becomes the answer box' },
      { test: 'tests/e2e/ai-questions.mjs', kind: 'e2e', step: 'an empty answer sends nothing' },
      { test: 'tests/e2e/ai-questions.mjs', kind: 'e2e', step: 'reopening the thread shows every question and answer' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'thread B: an interview, answered with a choice and then a typed answer' },
      { test: 'tests/unit/chat-questions.test.ts', kind: 'unit' },
      { test: 'tests/e2e/ai-ask.mjs', kind: 'e2e', step: 'while the AI reads, the editor says so and the author keeps editing' },
      { test: 'tests/e2e/ai-questions.mjs', kind: 'e2e', step: 'while it waits, the editor says who must act and nothing keeps moving (issue #267)' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'mid-run: another thread opens while the run goes on in its own, the dock switches away and back, and the held run’s wait is its own' }
    ]
  },
  {
    id: 'assistant.images',
    area: 'assistant',
    intent: 'Show the assistant a particular photo from my library',
    start: 'Two different photos both named hero in the library',
    routes: ['chat:Images', 'item:Chat:Browse in Assets…', 'panel:Assets › Use in AI chat', 'item:Chat:<data>'],
    outcome: 'The photo goes to the chat from its details and stays across a page switch; removed before sending, nothing is sent; sent, the model gets its asset ID and name and never the picture; a question shows both photos told apart by ID and the choice answers with that exact one',
    scenario: 'Blank starter · scripted model server',
    proof: [
      { test: 'tests/e2e/ai-images.mjs', kind: 'e2e', step: 'the second photo, opened in Assets, says which one it is and goes to the AI chat' },
      { test: 'tests/e2e/ai-images.mjs', kind: 'e2e', step: 'attached again and sent: the model gets the asset ID and name, never the picture' },
      { test: 'tests/e2e/ai-images.mjs', kind: 'e2e', step: 'choosing the other photo from its preview answers with that exact photo' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'with the image attached from the composer’s picker' },
      { test: 'tests/unit/chat-drafts.test.ts', kind: 'unit', step: 'attaches an image once per message, up to four, and takes one out again' }
    ],
    gaps: [{ missing: 'Browse in Assets… in the composer’s image menu is never chosen by a test', owner: 'assistant' }]
  },
  {
    id: 'assistant.conversations',
    area: 'assistant',
    intent: 'Find, rename or delete a conversation, and come back to a message I had not sent',
    start: 'A project with several conversations and unsent text',
    routes: ['chat:Conversations', 'chat:New conversation', 'item:Chat:Find, rename or delete…', 'item:Chat:Clear history…', 'chat:Message', 'item:Chat:Message with *', 'chat:Continue', 'item:Chat:<data>'],
    outcome: 'A continued conversation moves to the top; it is renamed and found by a phrase from a later request; one is deleted after a cancelled attempt, its draft with it; each conversation keeps its own draft across switches, projects and a restart; an unfinished request offers Continue; after a reopen the kept threads and the site edit are there',
    scenario: 'Blank starter · scripted model server',
    proof: [
      { test: 'tests/e2e/conversations.mjs', kind: 'e2e', step: 'the keeper reopened from the manager and continued: it moves to the top' },
      { test: 'tests/e2e/conversations.mjs', kind: 'e2e', step: 'found by a distinctive phrase from a later request' },
      { test: 'tests/e2e/conversations.mjs', kind: 'e2e', step: 'deleting it: cancelled once, then confirmed' },
      { test: 'tests/e2e/conversations.mjs', kind: 'e2e', step: 'the project closed and opened again: the kept threads, their messages and the site edit are there' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'thread A reopened from the history: its own turns, and none of B’s' },
      { test: 'tests/unit/conversations.test.ts', kind: 'unit' },
      { test: 'tests/unit/chat-drafts.test.ts', kind: 'unit', step: 'clearing history right after a request finishes does not bring its transcript back' },
      { test: 'tests/e2e/chat-drafts.mjs', kind: 'e2e', step: 'returning to a thread restores its own draft, across earlier threads' },
      { test: 'tests/e2e/chat-drafts.mjs', kind: 'e2e', step: 'a draft left in a new conversation can be picked up again' },
      { test: 'tests/e2e/chat-drafts.mjs', kind: 'e2e', step: 'a draft in a new conversation survives a restart' },
      { test: 'tests/e2e/chat-drafts.mjs', kind: 'e2e', step: 'an unfinished request offers Continue' },
      { test: 'tests/unit/chat-drafts.test.ts', kind: 'unit', step: 'keeps a message that has only images as a draft: listed, restored and moved with its conversation' }
    ],
    gaps: [{ missing: 'Clear history… is never chosen by an e2e script', owner: 'assistant' }]
  },
  {
    id: 'assistant.failure',
    area: 'assistant',
    intent: 'Try again when the AI provider failed',
    start: 'A request that the provider refuses or cannot answer',
    routes: ['chat:Edit and try again', 'chat:Try again'],
    outcome: 'The failure shows on its turn saying nothing changed; Edit and try again sends the request again as a new run; Try again lands it once the model answers',
    scenario: 'business-v1 · scripted; Business starter · scripted model server',
    proof: [
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'a provider failure shows on its turn; Edit and try again sends the request again as a new run' },
      { test: 'tests/e2e/local.mjs', kind: 'e2e', step: 'no server: Chat says so instead of offering starters, and a request fails saying nothing changed' },
      { test: 'tests/e2e/local.mjs', kind: 'e2e', step: 'once the model answers, Try again lands the same request' },
      { test: 'tests/unit/adapters.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assistant.local',
    area: 'assistant',
    intent: 'Use an AI model running on my own computer',
    start: 'Business site, Settings › AI assistant',
    routes: ['toolbar:Settings', 'dialog:Settings › AI assistant › Local model', 'dialog:Settings › Test connection', 'chat:Model'],
    outcome: 'A preset is picked, the server’s models discovered and one chosen, the connection tested; a cloud key in the Local field is refused and never sent; each turn names its model; switching servers or models moves the requests, and a message goes only to the model the composer named',
    scenario: 'Business starter · scripted model server',
    proof: [
      { test: 'tests/e2e/local.mjs', kind: 'e2e', step: 'the server models are discovered and the second is chosen' },
      { test: 'tests/e2e/local.mjs', kind: 'e2e', step: 'a cloud key pasted into the Local key field is refused, and never sent' },
      { test: 'tests/e2e/local.mjs', kind: 'e2e', step: 'a message goes only to the model the composer named, even if Settings changed underneath' },
      { test: 'tests/e2e/local.mjs', kind: 'e2e', step: 'a second server: the model menu and the requests follow it' },
      { test: 'tests/unit/local-adapter.test.ts', kind: 'unit' },
      { test: 'tests/unit/local-model-per-server.test.ts', kind: 'unit' },
      { test: 'tests/unit/local-settings.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assistant.component',
    area: 'assistant',
    intent: 'Ask the assistant to change a component’s design everywhere',
    start: 'Business site, the hero edited everywhere, Developer mode off',
    routes: ['item:Inspector:Edit everywhere…', 'chat:Message'],
    outcome: 'The composer is about the component, not the page behind it; asking for an editable tagline adds a property and binds a new element to it, and nothing on the page changes; finishing takes the composer back to the page',
    scenario: 'Business starter · scripted model server',
    proof: [
      { test: 'tests/e2e/ai-edit-everywhere.mjs', kind: 'e2e', step: 'the composer is about the component, not the page behind it' },
      { test: 'tests/e2e/ai-edit-everywhere.mjs', kind: 'e2e', step: 'asking for an editable tagline adds a property and binds a new element to it, and nothing else' },
      { test: 'tests/unit/agent.test.ts', kind: 'unit', step: 'adds an editable element to the whole component from its overview, and nothing outside it' }
    ]
  },
  {
    id: 'assistant.write-page',
    area: 'assistant',
    intent: 'Have the assistant write an empty page for me',
    start: 'A new Blank page, or a page with only its introduction',
    routes: ['canvas:Write with AI'],
    outcome: 'Write with AI opens the AI panel about that page with the message box focused, before a provider is connected too',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/page-starters.mjs', kind: 'e2e', step: 'with no AI provider, Write with AI still opens a message box for the page’s copy' },
      { test: 'tests/e2e/page-starters.mjs', kind: 'e2e', step: 'with a provider connected, Write with AI focuses the message box about the empty page' },
      { test: 'tests/unit/write-with-ai.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'assistant.fix',
    area: 'assistant',
    intent: 'Have the assistant fix problems the checks found',
    start: 'A page with readability defects, or SEO findings in Project health or the Export dialog',
    routes: ['dialog:Project health › Fix with AI', 'dialog:Export › Fix with AI', 'chat:Message'],
    outcome: 'The layout inspection the assistant runs reports each defect on the element to change, an operation given that reference fixes it, and the page then reports nothing; a finding the AI can fix becomes a request about that page or the whole site, and none is offered for what it cannot reach',
    scenario: 'Blank starter · none; unit fixtures',
    proof: [
      { test: 'tests/unit/seo-handoff.test.ts', kind: 'unit', step: 'offers none for what the AI can’t fix, what it can’t reach, or what has gone' },
      { test: 'tests/e2e/inspect-layout.mjs', kind: 'e2e', step: 'each defect is reported on the element to change' },
      { test: 'tests/e2e/inspect-layout.mjs', kind: 'e2e', step: 'fixed through the references it gave, the page reports nothing again' },
      { test: 'tests/unit/inspect-layout.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'No e2e script presses Fix with AI in Project health or the Export dialog', owner: 'assistant' }]
  },
  {
    id: 'assistant.live',
    area: 'assistant',
    intent: 'Make changes with a real AI provider',
    start: 'Business site with a real OpenAI key',
    routes: ['chat:Message'],
    outcome: 'A targeted edit changes only the element selected when it was sent; a multi-step request adds a page and updates shared navigation; a configured provider’s requests are capped and time-bounded by the app',
    scenario: 'Business starter · live provider',
    proof: [
      { test: 'tests/e2e/ai.mjs', kind: 'e2e', step: 'A01: a targeted edit changes only the element selected when it was sent' },
      { test: 'tests/e2e/ai.mjs', kind: 'e2e', step: 'A02: a multi-step request adds a page and updates shared navigation' },
      { test: 'tests/e2e/assistant.mjs', kind: 'driver', step: 'a configured provider, by explicit opt-in' }
    ],
    gaps: [{ missing: 'ai.mjs costs money and runs only when asked, so routine runs prove the assistant against scripted models only', owner: 'assistant', issue: 130 }]
  },
  // ---- posts ----
  {
    id: 'posts.write',
    area: 'posts',
    intent: 'Write a blog post with pictures and a featured image',
    start: 'Business site with a photo in the library',
    routes: [
      'tab:posts',
      'panel:Posts › New post',
      'panel:Posts › writer',
      'panel:Posts › Featured image',
      'item:Posts:Open *',
      'item:Posts:Open (already open)',
      'item:Posts:Duplicate as draft',
      'item:Posts:Delete *…'
    ],
    outcome: 'A new post creates the blog and opens the centred writer; headings, lists, a page link and a library picture with its caption are saved; nothing typed is lost on switching panels; Undo and Redo are the project’s; the featured image is chosen, imported and removed in the visual picker, each an undo step',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'the Content tab starts the blog in one click, and a new post opens the writer' },
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'writing: paragraphs, a section heading, a list and a link to a page' },
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'the last words, then straight to Assets: nothing typed is lost' },
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'Undo and Redo are the project’s, kept with it' },
      { test: 'tests/unit/post-workspace.test.ts', kind: 'unit' },
      { test: 'tests/unit/post-draft.test.ts', kind: 'unit' },
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'the featured image is chosen, imported and removed in the visual picker, each an undo step (#563)' }
    ],
    gaps: [{ missing: 'Duplicate as draft and Delete in a post’s menu are never chosen by a test', owner: 'posts' }]
  },
  {
    id: 'posts.publish',
    area: 'posts',
    intent: 'Publish a post, backdated if need be, and set how it shows in search and shared links',
    start: 'A post being written',
    routes: ['panel:Posts › Save draft', 'panel:Posts › Date', 'panel:Posts › Publish', 'panel:Posts › Preview in site', 'panel:Posts › Search & sharing'],
    outcome: 'The draft previews in the site’s header and footer; backdated and published it shows in the site; Search & sharing previews it as results, a shared link and structured data as it is typed; the exported website has the published posts, keeps a renamed one’s old address, and leaves the draft out of pages and sitemap',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'saved as a draft, previewed in the site' },
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'back to writing, backdated and published' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#393: posts published, one renamed after publishing, and a draft' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#393: the website has the published posts, keeps the renamed one' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#393: the sitemap under /studio lists each published post with the day it last changed, and no draft' },
      { test: 'tests/unit/posts-articles.test.ts', kind: 'unit' },
      { test: 'tests/unit/collection-routes.test.ts', kind: 'unit' },
      { test: 'tests/e2e/seo-view.mjs', kind: 'e2e', step: 'a post’s search result, link preview and structured data follow what is typed before it is saved (#597)' },
      { test: 'tests/e2e/posts.mjs', kind: 'e2e', step: 'Search & sharing keeps its fields and meters, and opens the post in the SEO view with what is typed saved first (#708)' },
      { test: 'tests/e2e/seo-health.mjs', kind: 'e2e', step: 'entry: from a page, Open post opens the post with its excerpt focused' },
      { test: 'tests/unit/entry-seo.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'posts.taxonomy',
    area: 'posts',
    intent: 'File posts under categories and tags, and manage them',
    start: 'Business site with three posts, two published',
    routes: ['panel:Posts › Categories and tags', 'item:Posts:*…', 'panel:Posts › writer › Category', 'panel:Posts › Filter', 'panel:Posts › options › Sort', 'item:Posts:<data>'],
    outcome: 'Categories and tags are added in the manager and as they are typed; the list narrows by category, status and words; a rename moves the address, its posts and a list of posts choosing it in one undo step; a delete says how many posts it is on and is refused while a list chooses it',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/post-taxonomy.mjs', kind: 'e2e', step: 'categories and tags added in the manager' },
      { test: 'tests/e2e/post-taxonomy.mjs', kind: 'e2e', step: 'the list narrowed by category, by Published or Drafts, and by its words' },
      { test: 'tests/e2e/post-taxonomy.mjs', kind: 'e2e', step: 'the category renamed: its address, its posts and the list on Home follow it in one step' },
      { test: 'tests/e2e/post-taxonomy.mjs', kind: 'e2e', step: 'deleting a category says how many posts it is on; one a list of posts chooses is refused' },
      { test: 'tests/unit/post-taxonomy.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Sorting the list from its options menu is never chosen by a test', owner: 'posts' }]
  },
  {
    id: 'posts.import',
    area: 'posts',
    intent: 'Bring my blog over from WordPress or a folder of Markdown',
    start: 'Business site, a WordPress export with its uploads folder and a folder of Markdown posts',
    routes: ['panel:Posts › Import', 'item:Posts:WordPress export (.xml)…', 'item:Posts:Folder of Markdown posts…'],
    outcome: 'The review says what would come and Cancel brings nothing; importing is one change Undo and Redo take whole; pictures become library images with responsive copies, old WordPress addresses keep working, nothing unsafe arrives, and a hostile export is refused while the editor keeps answering',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/posts-import.mjs', kind: 'e2e', step: 'the review says what the WordPress export would bring, and Cancel brings nothing' },
      { test: 'tests/e2e/posts-import.mjs', kind: 'e2e', step: 'Undo takes the whole import back, and Redo brings it again' },
      { test: 'tests/e2e/posts-import.mjs', kind: 'e2e', step: 'a folder of Markdown posts joins them' },
      { test: 'tests/e2e/posts-import.mjs', kind: 'e2e', step: 'a hostile export is refused with a reason, and the editor keeps answering' },
      { test: 'tests/e2e/posts-import.mjs', kind: 'e2e', step: 'the static website has the imported blog, its old addresses and its sitemap' },
      { test: 'tests/unit/posts-import.test.ts', kind: 'unit' },
      { test: 'tests/unit/posts-import-readers.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'posts.feed',
    area: 'posts',
    intent: 'List my latest posts on the home page and in a blog index',
    start: 'Business site with published posts',
    routes: ['panel:Insert › Posts list', 'inspector:Posts list › Category'],
    outcome: 'The exported website lists the posts on Home and in the blog’s pages of two, with category archives, a backdated post in its place, and a visitor moving through them; the RSS feed lists every published post, newest first',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#397: a post feed on Home, the blog index in pages of two, category archives, and a post backdated' },
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#397: the website lists the posts on Home and in the blog' },
      { test: 'tests/unit/blog-feeds.test.ts', kind: 'unit' },
      { test: 'tests/unit/blog-syndication.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Loops are limited to the blog’s own feed; listing entries of any collection with chosen fields and filters is still to come', owner: 'posts', issue: 672 }]
  },
  {
    id: 'posts.layout',
    area: 'posts',
    intent: 'Change the layout every post uses, once',
    start: 'Business site with published posts',
    routes: ['panel:Pages › Collections › Posts › Edit layout', 'item:Posts:Edit layout'],
    outcome: 'The posts layout opens on the canvas, shows any post, and an edit to it reaches every post',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/export.mjs', kind: 'e2e', step: '#394: the posts layout, opened on the canvas, shown on any post, and edited once for every post' },
      { test: 'tests/unit/collection-templates.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Edit layout in the Content panel’s options menu is never chosen by a test; the proof opens it from Pages', owner: 'posts' }]
  },
  {
    id: 'posts.collections',
    area: 'posts',
    intent: 'Keep a collection of my own (team members, projects, products) with its own fields',
    start: 'A project open',
    routes: ['tab:posts', 'item:Posts:<data>', 'item:Posts:Add a collection…', 'item:Posts:Collection settings…', 'item:CollectionSchemaDialog:<data>'],
    outcome: 'The engine creates a custom collection beside the blog with readable settings, refuses clashing IDs and addresses, and keeps pages off entry addresses',
    scenario: 'unit fixtures · none',
    proof: [
      { test: 'tests/unit/collections.test.ts', kind: 'unit', step: 'creates the ready-made blog and a custom collection with readable settings' },
      { test: 'tests/unit/collection-session.test.ts', kind: 'unit' }
    ],
    gaps: [
      { missing: 'The Content panel adds, switches to and edits collections (Add a collection…, Collection settings…, Add a field), but no test drives them through the app', owner: 'posts', issue: 672 },
      { missing: 'Collections every site can use as visual components (team, testimonials, products) are still to come', owner: 'posts', issue: 346 }
    ]
  },
  {
    id: 'posts.external',
    area: 'posts',
    intent: 'Show content from another CMS or my own API, read-only',
    start: 'An empty collection and an external content source (Contentful, Sanity, Strapi, WordPress REST, GraphQL or a REST/JSON API)',
    routes: [
      'panel:Posts › External source',
      'item:Posts:Connect external source…',
      'item:Posts:Source settings…',
      'item:Posts:Sync now',
      'item:Posts:Syncing…',
      'item:Posts:Detach to local collection',
      'dialog:Connect external source › Test & Fetch Sample'
    ],
    outcome: 'Test reads the source and shows its first records as sent and as entries, writing nothing; Save keeps the settings it tested; a sync brings read-only entries with library pictures, shown on their pages, in the archive and in collection queries; settings changed outside the app do not send a secret until saved here again; Detach makes the entries local in one undoable step',
    scenario: 'unit fixtures · mock Contentful and REST servers',
    proof: [
      { test: 'tests/unit/source-connect.test.ts', kind: 'unit', step: 'maps a Contentful space into read-only entries with their pictures, shown on their pages and in the archive' },
      { test: 'tests/unit/source-connect.test.ts', kind: 'unit', step: 'converts a custom REST API with the project’s converter.mjs, kept beside the source’s settings' },
      { test: 'tests/unit/source-connect.test.ts', kind: 'unit', step: 'never takes the user’s secret where settings changed outside the app say, until they are saved here again' },
      { test: 'tests/unit/source-connect.test.ts', kind: 'unit', step: 'detaches into a local collection: no source on the collection or its entries, which are edited as any other' },
      { test: 'tests/unit/source-controller.test.ts', kind: 'unit', step: 'is only done by Connect external source, which tests them first' },
      { test: 'tests/unit/source-form.test.ts', kind: 'unit' },
      { test: 'tests/unit/source-adapters.test.ts', kind: 'unit' },
      { test: 'tests/unit/source-converter.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'No e2e script drives Connect, Test, Save, Sync now and Detach through the built app', owner: 'posts', issue: 672 }]
  },
  {
    id: 'posts.ui-state',
    area: 'posts',
    intent: 'Build tabs or a drawer into a component, with a state the visitor switches',
    start: 'Blank site, a project component with two buttons and two panels, in Component Studio',
    routes: ['item:Insert:Open in Component Studio', 'inspector:Component › UI state', 'toolbar:Preview state'],
    outcome: 'The Inspector declares a Billing choice; each button switches it and each panel shows for its option; the studio toolbar previews a state so its hidden panel can be picked and styled without saving; every change undoes cleanly; a local model builds working tabs in one call, which work in the visitor preview and one Undo takes back',
    scenario: 'Blank starter · scripted model server',
    proof: [
      { test: 'tests/e2e/ui-state.mjs', kind: 'e2e', step: 'the Inspector declares a Billing choice on the whole component' },
      { test: 'tests/e2e/ui-state.mjs', kind: 'e2e', step: 'the toolbar previews Annual, so its hidden panel can be picked and styled' },
      { test: 'tests/e2e/ui-state.mjs', kind: 'e2e', step: 'every change undoes cleanly, back to the component as it was' },
      { test: 'tests/e2e/ui-state.mjs', kind: 'e2e', step: 'the tabs work in the visitor preview' },
      { test: 'tests/unit/ui-state.test.ts', kind: 'unit' },
      { test: 'tests/unit/ui-state-controls.test.ts', kind: 'unit' }
    ]
  },
  // ---- settings ----
  {
    id: 'settings.provider',
    area: 'settings',
    intent: 'Connect an AI provider with my API key',
    start: 'A project open, Settings closed',
    routes: ['toolbar:Settings', 'command:settings', 'item:Toolbar:Settings…', 'item:Chat:Manage providers and keys…', 'dialog:Settings › AI assistant › API key'],
    outcome: 'The key is stored in a user-only local file and never in the OS keychain; once typed, it never comes back in an observation, a screenshot or a run record; in a zoomed-in interface Settings… is in the More menu',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/smoke.mjs', kind: 'e2e', step: 'API keys are stored in a user-only local file, never the OS keychain' },
      { test: 'tests/e2e/snapshot.mjs', kind: 'driver', step: 'a dialog over the editor, focus in it, and a credential that never comes back' },
      { test: 'tests/e2e/outcomes.mjs', kind: 'driver', step: 'a credential typed into Settings is kept out of the record' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'a credential entered through the actions never comes back, nor does a screenshot while it is known' },
      { test: 'tests/e2e/mcp.mjs', kind: 'driver', step: 'once a credential is known, no screenshot comes back, not even one taken before' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'a zoomed-in interface moves Zoom and Settings into a labelled More menu' },
      { test: 'tests/unit/local-key-storage.test.ts', kind: 'unit' },
      { test: 'tests/unit/chat-model-menu-browser.test.ts', kind: 'unit', step: 'ends with Manage providers and keys, which opens the AI assistant settings' }
    ],
    gaps: [{ missing: 'Settings… from the command menu is never chosen by a test', owner: 'settings' }]
  },
  {
    id: 'settings.menu',
    area: 'settings',
    intent: 'Open Settings from the application menu or its shortcut',
    start: 'Welcome, or a project open',
    routes: ['menu:SiteOrigin Builder > Settings…', 'menu:File > Settings…'],
    outcome: 'Settings opens over Welcome or the editor; the item is in the app menu on macOS and the File menu elsewhere, on Cmd/Ctrl+,',
    scenario: 'welcome · none; Business starter · none',
    proof: [
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Welcome: Settings… opens the Settings dialog' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'a project: Settings… opens the Settings dialog over the editor' },
      { test: 'tests/unit/app-menu.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'File > Settings… on Windows and Linux is never chosen by a local run, which is macOS only', owner: 'settings' }]
  },
  {
    id: 'settings.developer',
    area: 'settings',
    intent: 'Turn on Developer mode to work with code',
    start: 'A project open, Settings › General',
    routes: ['dialog:Settings › General › Developer mode'],
    outcome: 'Code components, their source and saved code are offered only while Developer mode is on',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/code.mjs', kind: 'e2e', step: 'turn on Developer mode' },
      { test: 'tests/e2e/command-insert.mjs', kind: 'e2e', step: 'code components are offered only in Developer mode' },
      { test: 'tests/e2e/saved-components.mjs', kind: 'e2e', step: 'In Developer mode the saved code shows, and asks before its code comes in' }
    ]
  },
  {
    id: 'settings.appearance',
    area: 'settings',
    intent: 'Use the editor in light or dark',
    start: 'Welcome or a project, Settings › Appearance',
    routes: ['dialog:Settings › Appearance', 'welcome:Appearance toggle'],
    outcome: 'Light and Dark change the editor only, while the preview keeps this computer’s scheme; System follows the computer as it changes; Welcome’s toggle switches in one click and is saved; the choice survives a restart and is drawn from the first paint',
    scenario: 'Blank starter · none',
    proof: [
      { test: 'tests/e2e/appearance.mjs', kind: 'e2e', step: 'Light and Dark change the editor only' },
      { test: 'tests/e2e/appearance.mjs', kind: 'e2e', step: 'a page loaded in the preview afterwards still sees this computer’s scheme' },
      { test: 'tests/e2e/appearance.mjs', kind: 'e2e', step: 'switches the editor between light and dark in one click, saved as the Appearance (#554)' },
      { test: 'tests/e2e/appearance.mjs', kind: 'e2e', step: 'the toggle’s choice survives a restart' },
      { test: 'tests/unit/appearance.test.ts', kind: 'unit' },
      { test: 'tests/unit/color-scheme.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'settings.site-details',
    area: 'settings',
    intent: 'Set the site’s public address, language, favicon and sharing image',
    start: 'Business site, Site styles › Site details',
    routes: ['panel:Site styles › Site details'],
    outcome: 'Text the project cannot take stays in the field as an unsaved draft with the reason and a fix beside the saved value; Add https:// saves; Escape discards for the saved value; the favicon and sharing image come from the library’s visual picker',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/site-details.mjs', kind: 'e2e', step: 'a host name typed without https:// stays in the field, unsaved, with the reason and a fix beside it' },
      { test: 'tests/e2e/site-details.mjs', kind: 'e2e', step: 'Add https:// saves the address it offers and clears the reason' },
      { test: 'tests/e2e/site-details.mjs', kind: 'e2e', step: 'a language name stays as typed with the reason, and Escape discards it for the saved code' },
      { test: 'tests/e2e/site-details.mjs', kind: 'e2e', step: 'the favicon and social image are chosen from the visual picker' },
      { test: 'tests/unit/site-url.test.ts', kind: 'unit' },
      { test: 'tests/unit/site-icons.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'settings.site-rename',
    area: 'settings',
    intent: 'Rename the site and have its name change everywhere',
    start: 'Business site, Site styles › Site details',
    routes: ['panel:Site styles › Site details › Site name', 'inspector:Footer › Use the site name'],
    outcome: 'The header’s brand, the footer’s brand and copyright line change in the live and the exported website; a footer name of the author’s own is kept and said so, and can follow the site name again',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/site-rename.mjs', kind: 'e2e', step: 'renaming the site in Site details renames the header, the footer and its copyright line' },
      { test: 'tests/e2e/site-rename.mjs', kind: 'e2e', step: 'the exported website shows the same' },
      { test: 'tests/e2e/site-rename.mjs', kind: 'e2e', step: 'the footer’s own field says it keeps its name, and Use the site name makes it follow again' },
      { test: 'tests/unit/site-rename.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'settings.panels',
    area: 'settings',
    intent: 'Show or hide the sidebar and the right panel, and switch their views',
    start: 'A project open',
    routes: ['key:\\', 'key:|', 'command:sidebar', 'command:dock', 'command:panel:*', 'panel:rail buttons', 'panel:right panel tabs'],
    outcome: 'Show the Insert panel leaves the cursor in Insert’s search; the open view is listed but cannot be chosen again; the sidebar hides from the command menu and shows again; Shift+Cmd/Ctrl+\\ hides and brings back the right panel; the right panel opens on the AI, its arrow keys move through the views, and the project reopens on the view chosen',
    scenario: 'Blank and Business starters · none',
    proof: [
      { test: 'tests/e2e/command-insert.mjs', kind: 'e2e', step: 'Show the Insert panel opens Insert with the cursor in its search' },
      { test: 'tests/e2e/command-insert.mjs', kind: 'e2e', step: 'the open view is listed but cannot be chosen again; the others can' },
      { test: 'tests/e2e/command-insert.mjs', kind: 'e2e', step: 'the sidebar hides from the menu, focus going to the view’s rail button, and shows again' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'a drag ends when the layout changes under it, instead of jumping' },
      { test: 'tests/e2e/smoke.mjs', kind: 'e2e', step: 'the right panel opens on the AI, the first of its views' },
      { test: 'tests/e2e/smoke.mjs', kind: 'e2e', step: 'the arrow keys move through the views in that order' },
      { test: 'tests/e2e/smoke.mjs', kind: 'e2e', step: 'a view chosen in the project is the one it reopens on' },
      { test: 'tests/unit/right-tabs.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Cmd/Ctrl+\\ for the sidebar, and Hide the right panel from the command menu, are never used by a test', owner: 'settings' }]
  },
  {
    id: 'settings.layout',
    area: 'settings',
    intent: 'Work in a small window, and make panels wider or narrower',
    start: 'A project with long names and both panels open, at the 1100×700 minimum',
    routes: ['panel:splitter drag', 'panel:splitter arrow keys', 'item:Editor:Narrower', 'item:Editor:Wider', 'item:Editor:Default width', 'toolbar:More', 'item:Editor:<data>'],
    outcome: 'The window stops at its minimum and the toolbar fits there; splitters and their arrow keys stop before the canvas gets too narrow; a wider window gives the panels their room back; the project reopens with its widths fitted and then restored; a new project starts with the default widths',
    scenario: 'Blank and Business starters · none',
    proof: [
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'splitters stop before the canvas gets too narrow' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'arrow keys stop at the same limits, and a step one way can be taken back' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'the project opens again in a small window with its panels fitted, then restores them' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'a new project starts with the default widths, not the last project’s' },
      { test: 'tests/unit/layout.test.ts', kind: 'unit' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'the native window stops at its declared 1100×700 minimum, and the toolbar fits there' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'the full toolbar comes back in a wider window' },
      { test: 'tests/e2e/pages-header.mjs', kind: 'e2e', step: 'the header fits at the default width and down to the minimum' }
    ],
    gaps: [{ missing: 'Narrower, Wider and Default width in a splitter’s menu are never chosen by a test', owner: 'settings' }]
  },
  {
    id: 'settings.command-menu',
    area: 'settings',
    intent: 'Find any command by typing its name',
    start: 'A project open',
    routes: ['key:k'],
    outcome: 'Cmd/Ctrl+K opens the command menu; a partial command name leads with the command, not a search of the content',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/page-switchers.mjs', kind: 'e2e', step: 'a partial command name leads with the command, not a search of the content' },
      { test: 'tests/e2e/layout.mjs', kind: 'e2e', step: 'the preview width and zoom are remembered wherever they are chosen' },
      { test: 'tests/e2e/tour.mjs', kind: 'design', step: 'settings, command menu and export' }
    ]
  },
  // ---- desktop ----
  {
    id: 'desktop.no-window',
    area: 'desktop',
    intent: 'Use the File menu after closing the window, as Mac apps allow',
    start: 'macOS, the app running with no window, with or without a project open',
    routes: ['menu:File > New Project…', 'menu:File > Open Project…', 'menu:File > Export…', 'menu:File > Close Project'],
    outcome: 'New Project, Open Project, Export and Close Project bring a window back and do what was asked once it is ready; a cancelled folder picker keeps Welcome or the project as it was',
    scenario: 'Business starter · none',
    platforms: ['darwin'],
    proof: [
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'no window (macOS): New Project brings up a window with its dialog' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'no window with a project open (macOS): Export brings the editor back with its dialog' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'no window with a project open (macOS): Close Project brings up the window and closes the project' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'File > Open Project… brings a new window and opens the project in it' },
      { test: 'tests/unit/menu-commands.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'desktop.close-window',
    area: 'desktop',
    intent: 'Close the window',
    start: 'A project open in the only window',
    routes: ['role:close', 'toolbar:window close button'],
    outcome: 'The focused field is saved first, or a refused one asks; on macOS the app keeps running with no window, elsewhere the last window closing quits the app',
    scenario: 'welcome · none; Business starter · none',
    proof: [
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'macOS: the window closes and the app keeps running' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'the last window closing quits the app' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'closing the window saves the focused field' }
    ],
    gaps: [
      { missing: 'The window is closed through the driver and BrowserWindow.close, never through Close Window in the macOS menu', owner: 'desktop' },
      { missing: 'The last-window-quits path runs only on Windows and Linux, which local runs do not cover', owner: 'desktop' }
    ]
  },
  {
    id: 'desktop.quit',
    area: 'desktop',
    intent: 'Quit Builder without losing what I was typing',
    start: 'A project open with an Inspector field focused',
    routes: ['role:quit'],
    outcome: 'Quitting saves the focused field; a refused draft asks first and Keep editing keeps the app open; quitting during a read-only preview removes the private copy',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'quitting saves the focused field' },
      { test: 'tests/e2e/lifecycle.mjs', kind: 'e2e', step: 'Keep editing keeps the app open' },
      { test: 'tests/e2e/read-only.mjs', kind: 'e2e', step: 'quitting during a read-only preview removes the copy' }
    ],
    gaps: [{ missing: 'Tests quit through the app, not through Quit in the macOS app menu or the File menu on Windows and Linux; the rest of the macOS app menu (About, Hide, Services) is Electron’s own', owner: 'desktop' }]
  },
  {
    id: 'desktop.notices',
    area: 'desktop',
    intent: 'Read the licences of what the app is made of',
    start: 'The app at Welcome or with a project open',
    routes: ['menu:Help > Third-Party Notices'],
    outcome: 'The installed app carries its own licence and a generated notices file with the full licence text of every bundled package and font; Help > Third-Party Notices opens that file',
    scenario: 'welcome · none',
    builds: ['dev', 'packaged'],
    proof: [
      { test: 'tests/e2e/packaged.mjs', kind: 'packaged' },
      { test: 'tests/unit/notices.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'desktop.system-menus',
    area: 'desktop',
    intent: 'Use the Edit, View and Window menu items the system supplies',
    start: 'A project open, typing in a field',
    routes: ['role:cut', 'role:copy', 'role:paste', 'role:delete', 'role:selectAll', 'role:resetZoom', 'role:zoomIn', 'role:zoomOut', 'role:togglefullscreen', 'role:windowMenu', 'role:about', 'role:services', 'role:hide', 'role:hideOthers', 'role:unhide'],
    outcome: 'A text field keeps its own paste rather than the editor’s section paste',
    scenario: 'Business starter · none',
    proof: [{ test: 'tests/e2e/copy-paste.mjs', kind: 'e2e', step: 'stays out of a text field: the toolbar’s width field keeps its own paste' }],
    gaps: [
      { missing: 'Cut, Copy, Paste, Delete and Select All in the Edit menu are Electron roles no test chooses', owner: 'desktop' },
      { missing: 'The View and Window menus are Electron roles; no test chooses their items', owner: 'desktop' }
    ]
  },
  {
    id: 'desktop.developer-menu',
    area: 'desktop',
    intent: 'Reload the editor or open the developer tools while working on Builder',
    start: 'Welcome or a project open, Developer mode on (or a development build)',
    routes: ['role:reload', 'role:forceReload', 'role:toggleDevTools'],
    outcome: 'View offers Reload, Force Reload and Toggle Developer Tools only in Developer mode or a development build, and an author gets none of them',
    scenario: 'welcome · none; Business starter · none',
    proof: [
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Settings… and Help are offered, and Reload and the developer tools only in Developer mode' },
      { test: 'tests/unit/app-menu.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'The items are Electron roles; no test chooses them', owner: 'desktop' }]
  },
  {
    id: 'desktop.help',
    area: 'desktop',
    intent: 'Find the SiteOrigin website, report a problem, or say which build is running in a bug report',
    start: 'Welcome or a project open',
    routes: [
      'role:help',
      'menu:Help > SiteOrigin Website',
      'menu:Help > Report a Problem…',
      'menu:Help > Copy Build Details',
      'menu:Help > Show Log File',
      'menu:Help > About SiteOrigin Builder'
    ],
    outcome:
      'The website and the repository’s new-issue form open in the browser through the checked external-link path, with nothing sent for the person; About shows the app’s name, version, commit and build time (in the app menu on macOS, in Help elsewhere, with Copy), and Copy Build Details puts them on the clipboard; Show Log File reveals the log the main process keeps of its errors and warnings, which names the build at each launch',
    scenario: 'welcome · none',
    proof: [
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Help: the website link is handed to the desktop' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Help: Report a Problem opens a new issue on the repository' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Help: Show Log File reveals the main process log, which names the build' },
      { test: 'tests/e2e/menu.mjs', kind: 'e2e', step: 'Help: About shows the version (Windows and Linux)' },
      { test: 'tests/unit/app-menu.test.ts', kind: 'unit' },
      { test: 'tests/unit/build-info.test.ts', kind: 'unit' },
      { test: 'tests/unit/main-log.test.ts', kind: 'unit' }
    ],
    gaps: [
      { missing: 'Help > About SiteOrigin Builder exists only on Windows and Linux, which local runs do not cover; the macOS About panel is Electron’s own and no test opens it', owner: 'desktop' },
      { missing: 'Copy Build Details and About’s Copy write the system clipboard, which no test chooses so a run never replaces the person’s clipboard; the text they copy is unit-tested', owner: 'desktop' },
      { missing: 'The website link is chosen only from Welcome', owner: 'desktop' }
    ]
  },
  {
    id: 'desktop.mac-text',
    area: 'desktop',
    intent: 'Use macOS text services: smart quotes and dashes, text replacement, speech, paste and match style',
    start: 'macOS, typing in a field',
    routes: ['role:pasteAndMatchStyle', 'role:showSubstitutions', 'role:toggleSmartQuotes', 'role:toggleSmartDashes', 'role:toggleTextReplacement', 'role:startSpeaking', 'role:stopSpeaking'],
    outcome: 'The system’s own text services act on the focused field',
    scenario: 'none',
    platforms: ['darwin'],
    proof: [],
    gaps: [{ missing: 'These Edit menu items are macOS roles Electron supplies; no test chooses them', owner: 'desktop' }]
  },
  {
    id: 'desktop.spelling',
    area: 'desktop',
    intent: 'Correct a misspelled word from a right-click',
    start: 'Business site, a misspelling typed in an Inspector field or in copy being edited on the canvas',
    routes: ['writing:<suggestion>', 'writing:No spelling suggestions', 'writing:Cut', 'writing:Copy', 'writing:Paste', 'writing:Select All'],
    outcome: 'The right-click offers the suggestions before Cut, Copy, Paste and Select All; choosing one corrects the word, Edit › Undo and Redo move it like typing, the correction saves and undoing the project takes it back; formatting in bold rich text is kept; a right-click on a section still opens its element actions',
    scenario: 'Business starter · none',
    proof: [
      { test: 'tests/e2e/spelling.mjs', kind: 'e2e', step: 'an inspector field offers the suggestions for a misspelled word' },
      { test: 'tests/e2e/spelling.mjs', kind: 'e2e', step: 'choosing a suggestion corrects the field, and Edit → Undo and Redo move it like typing' },
      { test: 'tests/e2e/spelling.mjs', kind: 'e2e', step: 'the correction saves, and undoing the project takes it back' },
      { test: 'tests/e2e/spelling.mjs', kind: 'e2e', step: 'a correction inside bold rich text keeps its formatting' },
      { test: 'tests/e2e/spelling.mjs', kind: 'e2e', step: 'a right-click on a section still opens its element actions' },
      { test: 'tests/unit/writing-menu.test.ts', kind: 'unit', step: 'says so when a misspelled word has no suggestions' }
    ],
    gaps: [{ missing: 'The writing menu’s Cut, Copy, Paste and Select All are read but never chosen; No spelling suggestions is a disabled line, checked only in its unit test', owner: 'desktop' }]
  },
  {
    id: 'desktop.choosers',
    area: 'desktop',
    intent: 'Choose folders and files with the system’s own chooser',
    start: 'Any action that asks for a folder or file',
    routes: ['dialog:System folder chooser', 'dialog:System save chooser'],
    outcome: 'Each chooser takes the answer set for it and is on the record; one nobody answered is closed at once with a reason and changes nothing, in the packaged app too; links and reveals are recorded, never opened',
    scenario: 'welcome · none; Business starter · none',
    builds: ['dev', 'packaged'],
    proof: [
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'a chooser nobody answered is closed at once, with a reason, and nothing changes' },
      { test: 'tests/e2e/desktop.mjs', kind: 'driver', step: 'every chooser so far is on the record, each taken by the answer set for it' },
      { test: 'tests/e2e/packaged.mjs', kind: 'packaged' },
      { test: 'tests/unit/headless-desktop.test.ts', kind: 'unit' },
      { test: 'tests/unit/driver-desktop.test.ts', kind: 'unit' }
    ]
  },
  {
    id: 'desktop.driver',
    area: 'desktop',
    intent: 'Drive and check Builder from another program, as an outside tester would',
    start: 'No app running; a client of the test driver or its MCP server',
    routes: ['welcome:New project', 'dialog:New project › Escape'],
    outcome: 'A session starts headless with its own profile and shares nothing with the next; observations cover the editor and the preview by role and name with stale refs refused; refused input fails with a reason; a client that disappears takes the app and its preview with it; a recorded journey replays in a fresh session',
    scenario: 'welcome · none; business-v1 · none',
    proof: [
      { test: 'tests/e2e/session.mjs', kind: 'driver', step: 'a client starts a session and reads who it is' },
      { test: 'tests/e2e/session.mjs', kind: 'driver', step: 'session B starts clean: no recent project, default settings, no key, no chat, an empty workspace' },
      { test: 'tests/e2e/session.mjs', kind: 'driver', step: 'a client that disappears takes its session, the app and its preview with it' },
      { test: 'tests/e2e/mcp.mjs', kind: 'driver', step: 'initialize and discover the tools, with nothing launched yet' },
      { test: 'tests/e2e/mcp.mjs', kind: 'driver', step: 'a stale ref is refused with a reason, and a fresh observation recovers' },
      { test: 'tests/e2e/snapshot.mjs', kind: 'driver', step: 'one bounded observation covers the editor and the site in its preview' },
      { test: 'tests/e2e/actions.mjs', kind: 'driver', step: 'what a person could not do fails with a reason, and changes nothing' },
      { test: 'tests/e2e/outcomes.mjs', kind: 'driver', step: 'the edit journey replays in a fresh session, finding its targets again' },
      { test: 'tests/unit/driver-protocol.test.ts', kind: 'unit' },
      { test: 'tests/unit/driver-mcp.test.ts', kind: 'unit' }
    ],
    gaps: [{ missing: 'Most rows here are proven by Playwright scripts rather than through the driver an outside tester uses', owner: 'desktop', issue: 489 }]
  }
];

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The list as Markdown: one table per area, then the gaps. */
export function toMarkdown(rows: Interaction[] = INTERACTIONS): string {
  const out = ['# Interaction coverage', '', `${rows.length} user intents. Generated from tests/coverage/interactions.ts.`, ''];
  for (const [area, title] of Object.entries(AREAS) as [Area, string][]) {
    const inArea = rows.filter((r) => r.area === area);
    if (!inArea.length) continue;
    out.push(`## ${title}`, '', '| Intent | Start | Routes | Outcome | Scenario | Applies | Proof | Gaps |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of inArea) {
      const applies = `${(r.platforms ?? ['darwin', 'win32', 'linux']).join(', ')}; ${(r.builds ?? ['dev']).join(', ')}`;
      const proof = [...new Set(r.proof.map((p) => `${p.test.replace(/^tests\//, '')} (${p.kind})`))].join('<br>');
      const gaps = (r.gaps ?? []).map((g) => `${g.missing} (${g.issue ? `#${g.issue}` : g.owner})`).join('<br>');
      out.push(`| ${[r.intent, r.start, r.routes.map((x) => `\`${x}\``).join(' '), r.outcome, r.scenario, applies, proof, gaps].map(cell).join(' | ')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--markdown')) process.stdout.write(`${toMarkdown()}\n`);
