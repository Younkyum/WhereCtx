import { afterEach, describe, expect, it } from "vitest";
import { createAppContext, type AppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { Browser, testConfig } from "../testing/accounts.js";
import { SoftAuthenticator } from "../testing/softAuthenticator.js";
import { passkeyBaseUrlProblem, SimpleWebAuthnCeremony } from "./passkeys.js";
import type { StoredPasskey } from "./passkeysStore.js";
import { asUserId } from "../types.js";

const ORIGIN = "https://where.example.com";
const ceremony = new SimpleWebAuthnCeremony({ baseUrl: ORIGIN });
const subject = { handle: "ab".repeat(32), name: "Jin" };

async function registered(authenticator = new SoftAuthenticator()) {
  const options = await ceremony.registrationOptions(subject, []);
  const response = authenticator.create(options, { origin: ORIGIN });
  const credential = await ceremony.verifyRegistration(response, options.challenge);
  expect(credential).not.toBeNull();
  const stored: StoredPasskey = { ...credential!, name: "Laptop", userId: asUserId("u") };
  return { authenticator, stored };
}

describe("SimpleWebAuthnCeremony with a software authenticator", () => {
  it("registers and then authenticates a credential, advancing the counter", async () => {
    const options = await ceremony.registrationOptions(subject, []);
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    expect(options.user.id).toBe(Buffer.from(subject.handle, "hex").toString("base64url"));

    const { authenticator, stored } = await registered();
    const login = await ceremony.authenticationOptions();
    expect(login.userVerification).toBe("required");
    const assertion = authenticator.get(login, stored.credentialId, { origin: ORIGIN });
    expect(await ceremony.verifyAuthentication(assertion, login.challenge, stored)).toEqual({
      newCounter: 1,
    });
  });

  it("rejects a registration from another origin or for another RP id", async () => {
    for (const context of [{ origin: "https://evil.example" }, { origin: ORIGIN, rpId: "evil.example" }]) {
      const options = await ceremony.registrationOptions(subject, []);
      const response = new SoftAuthenticator().create(options, context);
      expect(await ceremony.verifyRegistration(response, options.challenge)).toBeNull();
    }
  });

  it("rejects an assertion from another origin or for another RP id", async () => {
    const { authenticator, stored } = await registered();
    for (const context of [{ origin: "https://evil.example" }, { origin: ORIGIN, rpId: "evil.example" }]) {
      const login = await ceremony.authenticationOptions();
      const assertion = authenticator.get(login, stored.credentialId, context);
      expect(await ceremony.verifyAuthentication(assertion, login.challenge, stored)).toBeNull();
    }
  });

  it("requires user verification on registration and on sign-in", async () => {
    const options = await ceremony.registrationOptions(subject, []);
    const unverified = new SoftAuthenticator().create(options, { origin: ORIGIN, userVerified: false });
    expect(await ceremony.verifyRegistration(unverified, options.challenge)).toBeNull();

    const { authenticator, stored } = await registered();
    const login = await ceremony.authenticationOptions();
    const assertion = authenticator.get(login, stored.credentialId, { origin: ORIGIN, userVerified: false });
    expect(await ceremony.verifyAuthentication(assertion, login.challenge, stored)).toBeNull();
  });

  it("rejects a counter that does not advance (a cloned authenticator)", async () => {
    const { authenticator, stored } = await registered();
    const atFive = { ...stored, counter: 5 };
    for (const counter of [5, 3]) {
      const login = await ceremony.authenticationOptions();
      const assertion = authenticator.get(login, stored.credentialId, { origin: ORIGIN, counter });
      expect(await ceremony.verifyAuthentication(assertion, login.challenge, atFive)).toBeNull();
    }
  });

  it("rejects an assertion signed for a different challenge", async () => {
    const { authenticator, stored } = await registered();
    const login = await ceremony.authenticationOptions();
    const other = await ceremony.authenticationOptions();
    const assertion = authenticator.get(other, stored.credentialId, { origin: ORIGIN });
    expect(await ceremony.verifyAuthentication(assertion, login.challenge, stored)).toBeNull();
  });
});

describe("the HTTP flows with real WebAuthn", () => {
  let ctx: AppContext | undefined;
  afterEach(() => ctx?.handle.client.close());

  it("sets up the owner, then signs in with the same authenticator", async () => {
    const built = await createAppContext(testConfig({ baseUrl: ORIGIN }));
    ctx = built.ctx;
    const app = buildApp(ctx);
    const authenticator = new SoftAuthenticator();
    const code = built.bootstrap.setupCode!.reveal();

    const setup = new Browser(app, ORIGIN);
    const start = await setup.json("/v1/auth/setup/options", { body: { code } });
    const response = authenticator.create(start.options, { origin: ORIGIN });
    await setup.json("/v1/auth/setup/verify", { body: { code, ceremony: start.ceremony, response } });

    const browser = new Browser(app, ORIGIN);
    const login = await browser.json("/v1/auth/login/options", { body: {} });
    const assertion = authenticator.get(login.options, response.id, { origin: ORIGIN });
    expect(await browser.json("/v1/auth/login/verify", { body: { ceremony: login.ceremony, response: assertion } })).toEqual({
      userId: "owner",
    });
    expect((await browser.json("/v1/me")).passkeys[0].lastUsedAt).toBeDefined();

    const replayed = await new Browser(app, ORIGIN).send("/v1/auth/login/verify", {
      body: { ceremony: login.ceremony, response: assertion },
    });
    expect(replayed.status).toBe(401);
  });
});

describe("PasskeysStore.recordUse", () => {
  let ctx: AppContext | undefined;
  afterEach(() => ctx?.handle.client.close());

  it("only ever moves a non-zero counter forward", async () => {
    ctx = (await createAppContext(testConfig())).ctx;
    const store = ctx.system.passkeys;
    const userId = asUserId("owner");
    const base = { publicKey: "pk", transports: [], name: "Key" };
    await store.add(userId, { ...base, credentialId: "counting", counter: 1 });
    expect(await store.recordUse("counting", 5)).toBe(true);
    expect(await store.recordUse("counting", 5)).toBe(false);
    expect(await store.recordUse("counting", 3)).toBe(false);
    expect((await store.get("counting"))!.counter).toBe(5);

    await store.add(userId, { ...base, credentialId: "non-counting", counter: 0 });
    expect(await store.recordUse("non-counting", 0)).toBe(true);
    expect(await store.recordUse("non-counting", 0)).toBe(true);
  });
});

describe("passkeyBaseUrlProblem", () => {
  it.each([
    ["http://localhost:8787", null],
    ["http://app.localhost", null],
    ["https://where.example.com", null],
    ["http://127.0.0.1:8787", "IP address"],
    ["http://[::1]:8787", "IP address"],
    ["http://192.168.1.10:8787", "IP address"],
    ["https://203.0.113.7", "IP address"],
    ["http://where.example.com", "not https"],
  ])("%s", (baseUrl, problem) => {
    const found = passkeyBaseUrlProblem(baseUrl);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toContain(problem);
  });

  it("points the operator at localhost on the same port", () => {
    expect(passkeyBaseUrlProblem("http://127.0.0.1:8787")).toContain("http://localhost:8787");
  });
});
