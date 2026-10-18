// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

type Handler = (body: unknown) => { status: number; body?: unknown };

let routes: Map<string, Handler>;
let calls: string[];
let root: Root;
let host: HTMLElement;

const ME = {
  user: { id: "u1", displayName: "<img src=x onerror=alert(1)>" },
  workspaces: [{ id: "w1", name: "Home", role: "owner" }],
  passkeys: [],
  sessions: [],
};

const buf = (...b: number[]) => new Uint8Array(b).buffer;

function route(key: string, handler: Handler) {
  routes.set(key, handler);
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}" in: ${host.textContent}`);
  return found;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  routes = new Map();
  calls = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${path}`;
    calls.push(key);
    const handler = routes.get(key);
    const out = handler ? handler(init.body ? JSON.parse(String(init.body)) : undefined) : { status: 404, body: { error: "not found" } };
    return new Response(out.body === undefined ? "" : JSON.stringify(out.body), { status: out.status });
  });
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      get: vi.fn(async () => ({
        id: "cred",
        rawId: buf(1),
        type: "public-key",
        response: { clientDataJSON: buf(2), authenticatorData: buf(3), signature: buf(4), userHandle: null },
      })),
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("dashboard app", () => {
  it("shows sign-in without a session, signs in with a passkey, and lands on Home", async () => {
    let signedIn = false;
    route("GET /v1/me", () => (signedIn ? { status: 200, body: ME } : { status: 401, body: { error: "unauthorized" } }));
    route("POST /v1/auth/login/options", () => ({ status: 200, body: { ceremony: "c1", options: { challenge: "AQID" } } }));
    route("POST /v1/auth/login/verify", (body) => {
      expect(body).toMatchObject({ ceremony: "c1", response: { id: "cred", rawId: "AQ" } });
      signedIn = true;
      return { status: 200, body: { userId: "u1" } };
    });
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { sharingPaused: false } } }));
    route("GET /v1/presence", () => ({ status: 404, body: { error: "none" } }));
    route("GET /v1/people", () => ({ status: 200, body: { people: [] } }));

    await act(async () => root.render(<App />));
    await settle();
    expect(host.textContent).toContain("Sign in to WhereCtx");

    await act(async () => button("Sign in with a passkey").click());
    await settle();

    expect(calls).toContain("POST /v1/auth/login/verify");
    expect(host.querySelector("h1")?.textContent).toBe("Home");
    expect(host.textContent).toContain("No location yet");
    expect(host.textContent).toContain(ME.user.displayName);
    expect(host.querySelector("img")).toBeNull();
  });

  it("asks before deleting a place and deletes it only after the confirmation", async () => {
    let places = [{ name: "Gym", type: "custom", lat: 37.5, lon: 127, radiusM: 150 }];
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/places", () => ({ status: 200, body: { places } }));
    route("DELETE /v1/places/Gym", () => {
      places = [];
      return { status: 200, body: { ok: true } };
    });
    location.hash = "#places";
    await act(async () => root.render(<App />));
    await settle();

    await act(async () => button("Delete").click());
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Delete the place "Gym"?');
    expect(calls).not.toContain("DELETE /v1/places/Gym");

    const confirmButton = [...dialog!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete")!;
    await act(async () => confirmButton.click());
    await settle();
    expect(calls).toContain("DELETE /v1/places/Gym");
    expect(host.textContent).toContain("No places yet.");
    location.hash = "";
  });

  it("returns to sign-in when the session ends mid-use", async () => {
    let alive = true;
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/privacy", () => (alive ? { status: 200, body: { settings: { sharingPaused: false } } } : { status: 401, body: {} }));
    route("GET /v1/presence", () => ({ status: 404, body: {} }));
    route("GET /v1/people", () => ({ status: 200, body: { people: [] } }));
    route("GET /v1/places", () => ({ status: 401, body: { error: "unauthorized" } }));

    await act(async () => root.render(<App />));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Home");

    alive = false;
    await act(async () => {
      location.hash = "#places";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    expect(host.textContent).toContain("Sign in to WhereCtx");
  });
});
