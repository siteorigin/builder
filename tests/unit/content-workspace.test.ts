/**
 * The Content workspace (#675): starter and custom collections made in one step, what their entries are called, and
 * the schema dialog's draft saved as one collection.update the engine takes.
 */
import { describe, expect, it } from "vitest";
import type { EditOperation } from "@shared/ops";
import type { ProjectState } from "@shared/types";
import { COLLECTION_FIELD_TYPES } from "@shared/types";
import { createStarterState } from "@catalogue/starters";
import { applyOperations } from "@engine/apply";
import { validateState } from "@engine/validate";
import { hasArchivePages, hasDetailPages } from "@shared/collections";
import {
  STARTER_COLLECTIONS,
  contentRows,
  customCollectionOps,
  entryNoun,
  entryNounLower,
  fieldNameFor,
  freeCollectionId,
  newFieldSchema,
  retypeField,
  schemaDraftOf,
  schemaLosses,
  schemaUpdateOp,
  settleDraft,
  starterCollectionOps,
} from "../../src/renderer/src/lib/content";
import { newPostOps } from "../../src/renderer/src/lib/posts";

const run = (s: ProjectState, ops: EditOperation[]) =>
  applyOperations(s, ops).state;
const errors = (s: ProjectState) =>
  validateState(s).filter((d) => d.severity === "error");

describe("starter collections", () => {
  for (const starter of ["blank", "business"] as const) {
    it(`each one is made in one step on the ${starter} starter, and twice without clashing`, () => {
      let s = createStarterState(starter, "Riverside Studio", false);
      for (const c of STARTER_COLLECTIONS) {
        const plan = starterCollectionOps(s, c.id)!;
        s = run(s, plan.ops);
        expect(s.collections[plan.collectionId].settings.name).toBe(c.name);
      }
      expect(Object.keys(s.collections).sort()).toEqual([
        "posts",
        "projects",
        "team",
        "testimonials",
      ]);
      // The blog is the engine's own, once; the others are made again under numbered IDs and addresses.
      expect(starterCollectionOps(s, "posts")).toBeNull();
      const again = starterCollectionOps(s, "projects")!;
      s = run(s, again.ops);
      expect(again.collectionId).toBe("projects-2");
      expect(s.collections["projects-2"].settings.route).not.toBe(
        s.collections.projects.settings.route,
      );
      expect(errors(s)).toEqual([]);
    });
  }

  it("makes a data-only team whose members are added from the sidebar with every custom field", () => {
    let s = createStarterState("business", "Riverside Studio", false);
    s = run(s, starterCollectionOps(s, "team")!.ops);
    const team = s.collections.team;
    expect(team.settings.kind).toBe("structured");
    expect(
      hasDetailPages(team.settings) || hasArchivePages(team.settings),
    ).toBe(false);
    expect(Object.keys(team.settings.fields)).toEqual([
      "role",
      "department",
      "photo",
      "featured",
    ]);
    expect(entryNoun(team)).toBe("Team member");
    expect(entryNounLower(team)).toBe("team member");
    const { ops, ref } = newPostOps(s, "team", "Ana Ruiz");
    s = run(s, [
      ...ops,
      {
        type: "entry.update",
        collectionId: "team",
        entryId: ref.entryId,
        values: { role: "Potter", department: "Studio", featured: true },
      },
    ]);
    expect(s.collections.team.entries[ref.entryId].values).toEqual({
      role: "Potter",
      department: "Studio",
      featured: true,
    });
    expect(contentRows(s).find((r) => r.id === "team")).toEqual({
      id: "team",
      name: "Team",
      count: 1,
      noun: "Team member",
      synced: false,
    });
  });

  it("gives a project page an address nothing else has", () => {
    let s = createStarterState("business", "Riverside Studio", false);
    s = run(s, [
      {
        type: "page.create",
        title: "Projects",
        route: "/projects/",
      } as EditOperation,
    ]);
    const plan = starterCollectionOps(s, "projects")!;
    s = run(s, plan.ops);
    expect(s.collections.projects.settings.route).toBe("/projects-2/");
  });
});

describe("custom collections", () => {
  it("takes an ID from the name and pages only when asked", () => {
    const s = createStarterState("blank", "Riverside Studio", false);
    const data = customCollectionOps(s, {
      name: "Case Studies",
      singularName: "Case study",
      kind: "structured",
      pages: false,
    });
    expect(data.collectionId).toBe("case-studies");
    const made = run(s, data.ops);
    expect(hasDetailPages(made.collections["case-studies"].settings)).toBe(
      false,
    );
    expect(entryNoun(made.collections["case-studies"])).toBe("Case study");
    const paged = customCollectionOps(made, {
      name: "Case Studies",
      singularName: "",
      kind: "editorial",
      pages: true,
    });
    expect(paged.collectionId).toBe("case-studies-2");
    const both = run(made, paged.ops);
    expect(both.collections["case-studies-2"].settings.route).toBe(
      "/case-studies-2/",
    );
    expect(entryNoun(both.collections["case-studies-2"])).toBe("Post");
    expect(freeCollectionId(both, "日本語")).toBe("collection");
  });
});

describe("the schema dialog", () => {
  const team = () => {
    const s = createStarterState("business", "Riverside Studio", false);
    return run(s, [
      ...starterCollectionOps(s, "team")!.ops,
      {
        type: "entry.create",
        collectionId: "team",
        entryId: "en_ana1",
        title: "Ana",
        values: { role: "Potter" },
      },
    ]);
  };

  it("saves nothing when nothing changed", () => {
    const s = team();
    expect(
      schemaUpdateOp(s.collections.team, schemaDraftOf(s.collections.team)),
    ).toBeNull();
  });

  it("adds a field of every kind, and a grouping, in one change", () => {
    let s = team();
    const c = s.collections.team;
    const draft = schemaDraftOf(c);
    for (const type of COLLECTION_FIELD_TYPES) {
      const label = `My ${type}`;
      draft.fields.push({
        name: fieldNameFor(
          label,
          draft.fields.map((f) => f.name),
        ),
        schema: newFieldSchema(type, label, "team"),
        added: true,
      });
    }
    draft.taxonomies.push({
      id: "departments",
      label: "Departments",
      added: true,
    });
    const op = schemaUpdateOp(c, draft)!;
    expect(Object.keys(op).sort()).toEqual([
      "collectionId",
      "fields",
      "taxonomies",
      "type",
    ]);
    s = run(s, [op]);
    expect(Object.keys(s.collections.team.settings.fields)).toHaveLength(
      4 + COLLECTION_FIELD_TYPES.length,
    );
    expect(s.collections.team.settings.fields.myReference).toMatchObject({
      type: "reference",
      collection: "team",
    });
    expect(s.collections.team.settings.taxonomies.departments).toEqual({
      label: "Departments",
      terms: {},
    });
    expect(errors(s)).toEqual([]);
    // Saved, the draft is the collection again.
    expect(
      schemaUpdateOp(s.collections.team, schemaDraftOf(s.collections.team)),
    ).toBeNull();
  });

  it("renames a field by its label, keeping every value, and says what a removal takes", () => {
    let s = team();
    const draft = schemaDraftOf(s.collections.team);
    draft.fields = draft.fields.map((f) =>
      f.name === "role"
        ? { ...f, schema: { ...f.schema, label: "Job title" } }
        : f,
    );
    s = run(s, [schemaUpdateOp(s.collections.team, draft)!]);
    expect(s.collections.team.settings.fields.role.label).toBe("Job title");
    expect(s.collections.team.entries.en_ana1.values.role).toBe("Potter");
    const gone = schemaDraftOf(s.collections.team);
    gone.fields = gone.fields.filter((f) => f.name !== "role");
    expect(schemaLosses(s.collections.team, gone)).toEqual([
      "Job title: the value one entry has",
    ]);
    s = run(s, [schemaUpdateOp(s.collections.team, gone)!]);
    expect(s.collections.team.entries.en_ana1.values).toEqual({});
  });

  it("turns pages on at an address, and an archive off with entry pages", () => {
    let s = team();
    const draft = schemaDraftOf(s.collections.team);
    expect(draft.route).toBe("/team/");
    draft.detail = true;
    draft.archive = true;
    draft.route = "our-team";
    s = run(s, [schemaUpdateOp(s.collections.team, draft)!]);
    expect(s.collections.team.settings.route).toBe("/our-team/");
    expect(hasArchivePages(s.collections.team.settings)).toBe(true);
    const off = schemaDraftOf(s.collections.team);
    off.detail = false;
    expect(schemaUpdateOp(s.collections.team, off)).toMatchObject({
      pages: { detail: false, archive: false },
    });
  });

  it("names fields and groupings added in the dialog after their labels when saved", () => {
    const s = team();
    const c = s.collections.team;
    const draft = schemaDraftOf(c);
    draft.fields.push(
      {
        name: "",
        schema: newFieldSchema("string", " Role ", "team"),
        added: true,
        key: "new-1",
      },
      {
        name: "",
        schema: newFieldSchema("date", "Start date", "team"),
        added: true,
        key: "new-2",
      },
    );
    draft.taxonomies.push({
      id: "",
      label: "Offices",
      added: true,
      key: "new-3",
    });
    const settled = settleDraft(c, draft);
    if (typeof settled === "string") throw new Error(settled);
    expect(
      settled.fields.slice(-2).map((f) => [f.name, f.schema.label]),
    ).toEqual([
      ["role2", "Role"],
      ["startDate", "Start date"],
    ]);
    expect(settled.taxonomies.at(-1)).toEqual({
      id: "offices",
      label: "Offices",
    });
    expect(
      Object.keys(
        run(s, [schemaUpdateOp(c, settled)!]).collections.team.settings.fields,
      ),
    ).toContain("startDate");
    draft.fields[0] = {
      ...draft.fields[0],
      schema: { ...draft.fields[0].schema, label: "  " },
    };
    expect(settleDraft(c, draft)).toBe("Every field needs a label.");
  });

  it("starts a field changed to another kind afresh, keeping its label", () => {
    const f = retypeField(
      {
        type: "string",
        label: "Rating",
        default: "x",
        description: "Out of five",
      },
      "number",
      "team",
    );
    expect(f).toEqual({
      type: "number",
      label: "Rating",
      default: 0,
      description: "Out of five",
    });
  });

  it("names fields in camelCase, free of reserved and taken names", () => {
    expect(fieldNameFor("Job title", [])).toBe("jobTitle");
    expect(fieldNameFor("Job title", ["jobTitle"])).toBe("jobTitle2");
    expect(fieldNameFor("2nd phone", [])).toBe("field2ndPhone");
    expect(fieldNameFor("Default", [])).toBe("defaultField");
    expect(fieldNameFor("", [])).toBe("field");
  });
});
