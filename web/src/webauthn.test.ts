import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthenticationResponse, RegistrationResponse } from "../../src/api/accountHttp";
import { createAppContext } from "../../src/app/context";
import { buildApp } from "../../src/app/server";
import { Browser, testConfig } from "../../src/testing/accounts";
import { SoftAuthenticator } from "../../src/testing/softAuthenticator";
import * as lib from "./lib";

const ORIGIN = "http://localhost:8787";

let app: Hono;
let setupCode: string;

beforeAll(async () => {
  const booted = await createAppContext(testConfig());
  app = buildApp(booted.ctx);
  setupCode = booted.bootstrap.setupCode!.reveal();
});

/** Turn the soft authenticator's JSON into what a browser's PublicKeyCredential looks like. */
function browserCredential(json: any): any {
  const buf = (s: string) => lib.b64urlToBytes(s).buffer;
  const r = json.response;
  const response: any = { clientDataJSON: buf(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = buf(r.attestationObject);
    response.getTransports = () => ["internal"];
  } else {
    response.authenticatorData = buf(r.authenticatorData);
    response.signature = buf(r.signature);
    response.userHandle = buf(r.userHandle);
  }
  return {
    id: json.id,
    rawId: buf(json.rawId),
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response,
  };
}

describe("dashboard WebAuthn conversions against the real verifier", () => {
  it("sets up the owner, signs in and steps up with credentials shaped by the dashboard's lib", async () => {
    const auth = new SoftAuthenticator();
    const browser = new Browser(app);

    const setup = await browser.json("/v1/auth/setup/options", { body: { code: setupCode } });
    const creation = lib.creationOptionsFromJSON(setup.options);
    const created = auth.create(
      {
        challenge: lib.bytesToB64url(creation.challenge as Uint8Array),
        user: { id: lib.bytesToB64url(creation.user.id as Uint8Array) },
      },
      { origin: ORIGIN },
    );
    const registration = lib.registrationToJSON(browserCredential(created));
    expect(RegistrationResponse.safeParse(registration).success).toBe(true);
    const enrolled = await browser.json("/v1/auth/setup/verify", {
      body: { code: setupCode, ceremony: setup.ceremony, response: registration, passkeyName: "Mac" },
    });
    expect(enrolled.recoveryCodes).toHaveLength(8);

    const signIn = new Browser(app);
    const login = await signIn.json("/v1/auth/login/options", { body: {} });
    const request = lib.requestOptionsFromJSON(login.options);
    const asserted = auth.get({ challenge: lib.bytesToB64url(request.challenge as Uint8Array) }, created.id, { origin: ORIGIN });
    const assertion = lib.authenticationToJSON(browserCredential(asserted));
    expect(AuthenticationResponse.safeParse(assertion).success).toBe(true);
    expect((await signIn.json("/v1/auth/login/verify", { body: { ceremony: login.ceremony, response: assertion } })).userId).toBe(
      enrolled.userId,
    );

    const step = await signIn.json("/v1/me/reauth/options", { body: {} });
    const again = auth.get(
      { challenge: lib.bytesToB64url(lib.requestOptionsFromJSON(step.options).challenge as Uint8Array) },
      created.id,
      { origin: ORIGIN },
    );
    expect(
      (await signIn.json("/v1/me/reauth/verify", {
        body: { ceremony: step.ceremony, response: lib.authenticationToJSON(browserCredential(again)) },
      })).ok,
    ).toBe(true);
    const me = await signIn.json("/v1/me");
    expect(me.passkeys.map((p: any) => p.name)).toEqual(["Mac"]);
  });

  it("omits an empty userHandle and a null attachment rather than sending nulls", () => {
    const out = lib.authenticationToJSON({
      id: "AQ",
      rawId: new Uint8Array([1]).buffer,
      type: "public-key",
      authenticatorAttachment: null,
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null,
      },
    });
    expect(out).not.toHaveProperty("authenticatorAttachment");
    expect(out.response).not.toHaveProperty("userHandle");
    expect(out.clientExtensionResults).toEqual({});
    expect(AuthenticationResponse.safeParse(out).success).toBe(true);
  });
});
