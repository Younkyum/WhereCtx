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

  it("bypasses the check when private targets are allowed", async () => {
    const url = await assertSafeWebhookUrl("http://192.168.1.50/ha", true);
    expect(url.hostname).toBe("192.168.1.50");
  });
});
