import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Creating or editing something happens in a dialog: a page shows lists,
 * state and the buttons that open those dialogs. This reads the dashboard's
 * components and finds every form field that could render outside one.
 */

const SRC = import.meta.dirname;
const FILES = ["App.tsx", "MapView.tsx", "ui.tsx", ...readdirSync(join(SRC, "views")).map((f) => `views/${f}`)].filter((f) => f.endsWith(".tsx"));

/** Tags that make a form. Switches are not here: a single on/off switch may stay on the page. */
const FIELD = /<(form|TextInput|NumberInput|TextArea|CheckboxInput|RadioList|Selector|SegmentedControl)\b/g;

/** Components whose content a dialog shows: the form helper itself, and the steps a dialog holds. */
const DIALOG_HOSTS = /<(DialogForm|DialogResult)\b/;

/** Fields that stay on the page: which ones each component keeps there, and why. A file entry covers the whole page. */
const ON_PAGE: Record<string, { fields: string[]; why: string }> = {
  "ui.tsx:DialogForm": { fields: ["form"], why: "the dialog form itself" },
  "views/Gate.tsx:*": { fields: [], why: "sign-in and recovery happen before there is a dashboard to open a dialog in" },
  "views/Authorize.tsx:*": { fields: [], why: "the OAuth consent screen is a page of its own" },
  "views/Activity.tsx:ActivityView": { fields: ["Selector"], why: "filters the log by token" },
  "views/History.tsx:HistoryView": { fields: ["SegmentedControl"], why: "picks the time range to show" },
  "views/ServerLogs.tsx:ServerLogsView": { fields: ["SegmentedControl"], why: "filters the log by level" },
  "views/Maps.tsx:TryRoute": { fields: ["form", "TextInput"], why: "a route query, not something saved" },
  "ui.tsx:RouteModePicker": { fields: ["SegmentedControl"], why: "picks the travel mode of a route query (route tester, time to home), not something saved" },
  "views/Maps.tsx:ProviderPanel": { fields: ["Selector"], why: "one choice that applies as soon as it is picked" },
  "views/Workspace.tsx:CurrentWorkspace": { fields: ["Selector"], why: "switches which workspace the page shows" },
};

interface Component {
  file: string;
  name: string;
  body: string;
}

function components(): Component[] {
  const out: Component[] = [];
  for (const file of FILES) {
    const text = readFileSync(join(SRC, file), "utf8");
    const starts = [...text.matchAll(/^(?:export )?function (\w+)/gm)];
    starts.forEach((m, i) => {
      const end = i + 1 < starts.length ? starts[i + 1]!.index : text.length;
      out.push({ file, name: m[1]!, body: text.slice(m.index, end) });
    });
  }
  return out;
}

const fieldsIn = (c: Component) => [...new Set([...c.body.matchAll(FIELD)].map((m) => m[1]!))];

/** The fields a component renders that no ON_PAGE entry lets it keep on the page. */
const unlisted = (c: Component) => fieldsIn(c).filter((f) => !ON_PAGE[`${c.file}:${c.name}`]?.fields.includes(f));
const listedFile = (c: Component) => `${c.file}:*` in ON_PAGE;

/**
 * Components that render only inside a dialog or a listed file: a dialog
 * host, a component of a listed file, or one used only by those.
 */
function covered(all: Component[]): Set<string> {
  const inside = new Set(all.filter((c) => DIALOG_HOSTS.test(c.body) || listedFile(c)).map((c) => c.name));
  const users = (name: string) => all.filter((c) => c.name !== name && new RegExp(`<${name}\\b`).test(c.body));
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of all) {
      if (inside.has(c.name)) continue;
      const by = users(c.name);
      if (by.length && by.every((u) => inside.has(u.name))) {
        inside.add(c.name);
        changed = true;
      }
    }
  }
  return inside;
}

describe("create and edit forms live in dialogs", () => {
  const all = components();

  it("reads the dashboard's components", () => {
    expect(all.length).toBeGreaterThan(50);
    expect(all.find((c) => c.name === "AccountView")).toBeDefined();
  });

  it("renders no form field on a page outside a dialog, except the listed ones", () => {
    const inside = covered(all);
    const stray = all
      .filter((c) => unlisted(c).length && !inside.has(c.name))
      .map((c) => `${c.file}:${c.name} renders ${unlisted(c).join(", ")}`);
    expect(stray).toEqual([]);
  });

  it("lists only components that still render a field on the page", () => {
    const stale = Object.keys(ON_PAGE).filter((key) => {
      const [file, name] = key.split(":");
      return !all.some((c) => c.file === file && (name === "*" || c.name === name) && fieldsIn(c).length);
    });
    expect(stale).toEqual([]);
  });

  it("treats the converted views' fields as dialog content", () => {
    const inside = covered(all);
    for (const name of ["CreateAgentToken", "PairDevice", "RenameWorkspace", "ChangeRole", "CreateInvite", "CreateWorkspace", "EditName", "EditShare", "EditPrivacy"]) {
      expect(inside.has(name), name).toBe(true);
    }
  });
});
