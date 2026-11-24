// History and Undo name the list row and what was done to it (#27): add, move, edit a field, remove.
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createProject,
  eventually,
  launch,
  scratch,
  step,
} from "./harness.mjs";

const { WORK, cleanup } = scratch("list-history");
const { app, win, errors } = await launch(WORK);
await createProject(win, {
  name: "Harbour Lane Studio",
  parentDir: join(WORK, "sites"),
  starter: "business",
  sampleImages: true,
});
await win.waitForTimeout(1500);

const labels = () =>
  win.evaluate(async () =>
    (await window.builder.project.snapshot()).history.entries
      .filter((e) => e.applied)
      .map((e) => e.label),
  );
const last = async () => (await labels()).at(-1);

step("select the services cards");
if (!(await win.locator('[role="tree"]').first().isVisible()))
  await win.locator('.rail [aria-label="Layers"]').click();
await win
  .locator('[role="tree"] .list-item', { hasText: "Services grid" })
  .first()
  .click();
const cards = win.locator('#dock-panel-inspect [data-list="items"]');
await cards.waitFor();
const rows = cards.locator(".list-editor-head button.title");
const titles = async () => (await rows.allInnerTexts()).map((t) => t.trim());
const before = await rows.count();

step("an add names the card and the list");
await cards.getByRole("button", { name: /^Add / }).click();
await eventually(async () =>
  assert.equal(await rows.count(), before + 1, "a card is added"),
);
await eventually(async () =>
  assert.match(
    await last(),
    new RegExp(`^Add .* ${before + 1} to `),
    `History says which card was added: ${await last()}`,
  ),
);
assert.ok(!(await last()).startsWith("Edit "), "an add is not an Edit");

step("a move names the card and its places");
const subject = (await titles())[1];
await cards
  .locator(".list-editor-item", {
    has: win.locator("button.title", { hasText: subject }),
  })
  .getByRole("button", { name: `Move ${subject} up` })
  .click();
await eventually(async () =>
  assert.equal((await titles())[0], subject, "the card moved up"),
);
await eventually(async () =>
  assert.ok(
    (await last()).startsWith(`Move “${subject}” from 2 to 1 in `),
    `History says which card moved and where: ${await last()}`,
  ),
);

step("Undo says what it will undo");
const undoName = await win
  .locator('button[aria-label^="Undo"]')
  .first()
  .getAttribute("aria-label");
assert.ok(
  undoName.includes(`Move “${subject}”`),
  `the toolbar names the move: ${undoName}`,
);

step("a remove names the card");
const removeName = (await titles())[2];
await cards
  .locator(".list-editor-item", {
    has: win.locator("button.title", { hasText: removeName }),
  })
  .getByRole("button", { name: /^Remove / })
  .click();
await eventually(async () =>
  assert.ok(
    (await last()).startsWith(`Remove “${removeName}” from `),
    `History says which card was removed: ${await last()}`,
  ),
);

step("the entries are told apart");
const mine = (await labels()).slice(-3);
assert.equal(
  new Set(mine).size,
  3,
  `three different edits read three different ways: ${mine.join(" | ")}`,
);

assert.deepEqual(errors, [], "no uncaught errors in the editor");
await app.close();
cleanup();
console.log("\nlist-history: passed");
