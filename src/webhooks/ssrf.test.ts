import { describe, expect, it } from "vitest";
import { assertSafeWebhookUrl, ipIsPrivateOrReserved, SsrfError } from "./ssrf.js";

describe("ipIsPrivateOrReserved", () => {
  it("flags private/reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.4", "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
      expect(ipIsPrivateOrReserved(ip)).toBe(true);
    }
  });
  it("allows public IPv4", () => {
    for (const ip of ["93.184.216.34", "1.1.1.1", "8.8.8.8"]) {
      expect(ipIsPrivateOrReserved(ip)).toBe(false);
    }
  });
  it("flags private/reserved IPv6", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::3", "::ffff:127.0.0.1"]) {
      expect(ipIsPrivateOrReserved(ip)).toBe(true);
    }
  });
  it("allows public IPv6", () => {
    expect(ipIsPrivateOrReserved("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertSafeWebhookUrl", () => {
  const publicResolver = async () => ["93.184.216.34"];
  const privateResolver = async () => ["10.0.0.5"];

  it("rejects non-http(s) schemes", async () => {
    await expect(assertSafeWebhookUrl("ftp://x/y", false)).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeWebhookUrl("file:///etc/passwd", false)).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a host resolving to a private address", async () => {
    await expect(
      assertSafeWebhookUrl("https://evil.test/hook", false, privateResolver),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a literal metadata IP without resolving", async () => {
    await expect(assertSafeWebhookUrl("http://169.254.169.254/latest", false)).rejects.toBeInstanceOf(SsrfError);
  });

  it("accepts a host resolving to a public address", async () => {
    const url = await assertSafeWebhookUrl("https://example.test/hook", false, publicResolver);
    expect(url.hostname).toBe("example.test");
  });

  it("rejects a host that does not resolve", async () => {
    const notFound = async (): Promise<string[]> => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.test"), { code: "ENOTFOUND" });
    };
    const rejected = assertSafeWebhookUrl("https://nowhere.test/hook", false, notFound);
    await expect(rejected).rejects.toBeInstanceOf(SsrfError);
    await expect(rejected).rejects.toThrow("could not resolve host nowhere.test");
  });

  it("bypasses the check when private targets are allowed", async () => {
    const url = await assertSafeWebhookUrl("http://192.168.1.50/ha", true);
    expect(url.hostname).toBe("192.168.1.50");
  });
});

describe("IPv6 targets, as a URL spells them", () => {
  const noLookup = async (): Promise<string[]> => {
    throw new Error("an IP literal is never resolved");
  };
  const check = (url: string) => assertSafeWebhookUrl(url, false, noLookup);

  it.each([
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/", "[::ffff:7f00:1]"],
    ["IPv4-mapped metadata", "http://[::ffff:169.254.169.254]/", "[::ffff:a9fe:a9fe]"],
    ["IPv4-mapped RFC 1918", "http://[::ffff:10.0.0.1]/", "[::ffff:a00:1]"],
    ["IPv4-compatible loopback", "http://[::127.0.0.1]/", "[::7f00:1]"],
    ["NAT64 loopback", "http://[64:ff9b::127.0.0.1]/", "[64:ff9b::7f00:1]"],
    ["NAT64 metadata", "http://[64:ff9b::169.254.169.254]/", "[64:ff9b::a9fe:a9fe]"],
    ["local-use NAT64", "http://[64:ff9b:1::808:808]/", "[64:ff9b:1::808:808]"],
    ["6to4 of loopback", "http://[2002:7f00:1::1]/", "[2002:7f00:1::1]"],
    ["6to4 of metadata", "http://[2002:a9fe:a9fe::]/", "[2002:a9fe:a9fe::]"],
    ["Teredo to a private client", "http://[2001:0:5ef5:79fb::f5ff:fffe]/", "[2001:0:5ef5:79fb::f5ff:fffe]"],
    ["Teredo through a private server", "http://[2001:0:a00:1::f7f7:f7f7]/", "[2001:0:a00:1::f7f7:f7f7]"],
    ["loopback", "http://[0:0:0:0:0:0:0:1]/", "[::1]"],
    ["unspecified", "http://[::]/", "[::]"],
    ["link-local", "http://[fe80::1]/", "[fe80::1]"],
    ["link-local high in fe80::/10", "http://[febf::1]/", "[febf::1]"],
    ["unique local", "http://[fd12:3456::1]/", "[fd12:3456::1]"],
    ["multicast", "http://[ff02::1]/", "[ff02::1]"],
  ])("refuses %s", async (_case, url, hostname) => {
    expect(new URL(url).hostname).toBe(hostname);
    await expect(check(url)).rejects.toBeInstanceOf(SsrfError);
  });

  it.each([
    ["a public IPv6", "http://[2606:4700:4700::1111]/"],
    ["IPv4-mapped public", "http://[::ffff:8.8.8.8]/"],
    ["NAT64 of a public IPv4", "http://[64:ff9b::8.8.8.8]/"],
    ["6to4 of a public IPv4", "http://[2002:808:808::1]/"],
    ["Teredo between public addresses", "http://[2001:0:5ef5:79fb::f7f7:f7f7]/"],
  ])("accepts %s", async (_case, url) => {
    await expect(check(url)).resolves.toBeInstanceOf(URL);
  });
});
