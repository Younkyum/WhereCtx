import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setApiHooks } from "./api";
import { setUpOwner, signIn } from "./auth";

type Reply = { status: number; body?: unknown } | Error;
type Call = { path: string; method: string; body: unknown };

let calls: Call[];
let replies: Map<string, Reply[]>;
let signedOut: ReturnType<typeof vi.fn<() => void>>;
let reauthPrompted: ReturnType<typeof vi.fn<() => void>>;
let credentials: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

/** Queue replies for "METHOD /path"; each call takes the next one. */
function reply(route: string, ...queue: Reply[]) {
  replies.set(route, [...(replies.get(route) ?? []), ...queue]);
}

const bytes = (...b: number[]) => new Uint8Array(b).buffer;

function assertion(id: string) {
  return {
    id,
    rawId: bytes(1, 2),
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: { clientDataJSON: bytes(3), authenticatorData: bytes(4), signature: bytes(5), userHandle: bytes(6) },
  };
}

beforeEach(() => {
  calls = [];
  replies = new Map();
  signedOut = vi.fn<() => void>();
  reauthPrompted = vi.fn<() => void>();
  setApiHooks({ onSignedOut: signedOut, onReauth: reauthPrompted });
  credentials = { create: vi.fn(), get: vi.fn() };
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", credentials });
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    expect(init.credentials).toBe("same-origin");
    const next = replies.get(`${method} ${path}`)?.shift();
    if (!next) throw new Error(`unexpected ${method} ${path}`);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api() error policy", () => {
  it("treats a 401 without a code as a lost session and says it already handled it", async () => {
    reply("GET /v1/places", { status: 401, body: { error: "unauthorized" } });
    const err = await api("/v1/places").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).handled).toBe(true);
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it("leaves a coded 401 (an account refusal) and a sign-in call's 401 to the caller", async () => {
    reply("POST /v1/auth/recover", { status: 401, body: { error: "bad code" } });
    reply("DELETE /v1/me/passkeys/p1", { status: 401, body: { error: "no", code: "unauthorized" } });
    const wrongCode = (await api("/v1/auth/recover", { body: { code: "x" }, public: true }).catch((e: unknown) => e)) as ApiError;
    const refused = (await api("/v1/me/passkeys/p1", { method: "DELETE" }).catch((e: unknown) => e)) as ApiError;
    expect([wrongCode.status, wrongCode.handled]).toEqual([401, false]);
    expect([refused.code, refused.handled]).toEqual(["unauthorized", false]);
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("answers reauth_required with a passkey step-up, then retries the call once", async () => {
    reply("DELETE /v1/me/passkeys/p1", { status: 403, body: { error: "reauth", code: "reauth_required" }, }, { status: 200, body: { ok: true } });
    reply("POST /v1/me/reauth/options", { status: 200, body: { ceremony: "c1", options: { challenge: "AQID", allowCredentials: [{ id: "BAU", type: "public-key" }] } } });
    reply("POST /v1/me/reauth/verify", { status: 200, body: { ok: true } });
    credentials.get.mockResolvedValue(assertion("cred-1"));

    expect(await api("/v1/me/passkeys/p1", { method: "DELETE" })).toEqual({ ok: true });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /v1/me/passkeys/p1",
      "POST /v1/me/reauth/options",
      "POST /v1/me/reauth/verify",
      "DELETE /v1/me/passkeys/p1",
    ]);
    const publicKey = credentials.get.mock.calls[0]![0].publicKey;
    expect([...publicKey.challenge]).toEqual([1, 2, 3]);
    expect([...publicKey.allowCredentials[0].id]).toEqual([4, 5]);
    expect(calls[2]!.body).toEqual({
      ceremony: "c1",
      response: {
        id: "cred-1",
        rawId: "AQI",
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: { clientDataJSON: "Aw", authenticatorData: "BA", signature: "BQ", userHandle: "Bg" },
      },
    });
    expect(reauthPrompted).toHaveBeenCalledTimes(1);
  });

  it("does not loop when the retried call still wants a step-up", async () => {
    const again = { status: 403, body: { error: "reauth", code: "reauth_required" } };
    reply("POST /v1/me/recovery-codes", again, again);
    reply("POST /v1/me/reauth/options", { status: 200, body: { ceremony: "c1", options: { challenge: "AQID" } } });
    reply("POST /v1/me/reauth/verify", { status: 200, body: { ok: true } });
    credentials.get.mockResolvedValue(assertion("cred-1"));
    const err = (await api("/v1/me/recovery-codes", { method: "POST" }).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("reauth_required");
    expect(calls.filter((c) => c.path === "/v1/me/reauth/options")).toHaveLength(1);
  });

  it("reports an unreachable server as a network error", async () => {
    reply("GET /v1/me", new TypeError("Failed to fetch"));
    const err = (await api("/v1/me").catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.code]).toEqual([0, "network"]);
  });
});

describe("sign-in ceremonies", () => {
  it("signs in with a passkey: options, navigator.credentials.get, verify", async () => {
    reply("POST /v1/auth/login/options", { status: 200, body: { ceremony: "c9", options: { challenge: "AQID" } } });
    reply("POST /v1/auth/login/verify", { status: 200, body: { userId: "u1" } });
    credentials.get.mockResolvedValue(assertion("cred-9"));
    await signIn();
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[1]!.body).toMatchObject({ ceremony: "c9", response: { id: "cred-9", rawId: "AQI" } });
  });

  it("shows an unknown passkey as a sign-in failure, not a lost session", async () => {
    reply("POST /v1/auth/login/options", { status: 200, body: { ceremony: "c9", options: { challenge: "AQID" } } });
    reply("POST /v1/auth/login/verify", { status: 401, body: { error: "unknown credential" } });
    credentials.get.mockResolvedValue(assertion("cred-9"));
    const err = (await signIn().catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.handled]).toEqual([401, false]);
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("finishes first-time setup with recovery codes even when saving the name fails", async () => {
    reply("POST /v1/auth/setup/options", {
      status: 200,
      body: { ceremony: "s1", options: { challenge: "AQID", user: { id: "BAUG", name: "owner", displayName: "owner" } } },
    });
    reply("POST /v1/auth/setup/verify", { status: 201, body: { userId: "u1", recoveryCodes: ["a", "b"] } });
    reply("PATCH /v1/me", { status: 500, body: { error: "boom" } });
    credentials.create.mockResolvedValue({
      id: "new",
      rawId: bytes(7),
      type: "public-key",
      response: { clientDataJSON: bytes(8), attestationObject: bytes(9), getTransports: () => ["internal"] },
    });
    expect(await setUpOwner("CODE-1", "Jin")).toEqual({ recoveryCodes: ["a", "b"], renamed: false });
    expect([...credentials.create.mock.calls[0]![0].publicKey.user.id]).toEqual([4, 5, 6]);
    expect(calls[1]!.body).toEqual({
      code: "CODE-1",
      ceremony: "s1",
      passkeyName: "iPhone",
      response: {
        id: "new",
        rawId: "Bw",
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: "CA", attestationObject: "CQ", transports: ["internal"] },
      },
    });
    expect(calls[2]!.body).toEqual({ displayName: "Jin" });
  });
});
