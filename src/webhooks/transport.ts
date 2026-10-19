/**
 * How a delivery reaches its receiver. The SSRF check resolves a host name
 * and judges its addresses, but a second resolution at connect time could
 * answer differently (DNS rebinding). Here the check runs inside the
 * connection's own lookup, so the address the socket connects to is the one
 * that was judged. SNI and Host still carry the URL's host name.
 *
 * node:http never follows a redirect, so a 3xx is just a status: neither the
 * signature nor the auth header reaches a Location.
 */

import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { resolveHost, resolvePublic, type Resolver } from "./ssrf.js";

export interface DeliveryRequest {
  method: "POST";
  headers: Headers;
  body: string;
  signal: AbortSignal;
}

/** Sends one delivery. `fetch` fits, which is what tests pass. */
export type Transport = (url: string, init: DeliveryRequest) => Promise<{ ok: boolean; status: number }>;

/** A connect-time lookup that answers only with public addresses, or fails. */
export function publicLookup(resolver: Resolver = resolveHost): LookupFunction {
  return (hostname, options, callback) => {
    resolvePublic(hostname, resolver).then(
      (addresses) => {
        const all = addresses.map((address) => ({ address, family: isIP(address) }));
        const wanted = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
        const answer = wanted.length > 0 ? wanted : all;
        if (options.all) callback(null, answer);
        else callback(null, answer[0]!.address, answer[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}

export function connectTransport(opts: { allowPrivate: boolean; resolver?: Resolver }): Transport {
  const lookup = opts.allowPrivate ? undefined : publicLookup(opts.resolver);
  return (url, init) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const headers = { ...Object.fromEntries(init.headers), "content-length": String(Buffer.byteLength(init.body)) };
      const request = (target.protocol === "https:" ? https : http).request(
        target,
        { method: init.method, headers, signal: init.signal, lookup, agent: false },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status });
        },
      );
      request.on("error", reject);
      request.end(init.body);
    });
}
