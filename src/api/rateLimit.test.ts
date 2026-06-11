import { describe, expect, it } from "vitest";
import { AuthFailureLimiter } from "./rateLimit.js";

describe("AuthFailureLimiter", () => {
  it("blocks a key after maxFailures within the window", () => {
    let nowMs = 0;
    const limiter = new AuthFailureLimiter({
      windowMs: 60_000,
      maxFailures: 3,
      clock: () => new Date(nowMs),
    });
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    limiter.recordFailure("1.2.3.4");
    expect(limiter.isBlocked("1.2.3.4")).toBe(true);
    // Other keys are unaffected.
    expect(limiter.isBlocked("5.6.7.8")).toBe(false);
    // Window rotation clears the block.
    nowMs += 60_001;
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
  });

  it("caps the number of tracked keys (memory bound under key spoofing)", () => {
    const limiter = new AuthFailureLimiter({
      windowMs: 60_000,
      maxFailures: 1,
      maxEntries: 2,
      clock: () => new Date(0),
    });
    limiter.recordFailure("a");
    limiter.recordFailure("b");
    limiter.recordFailure("c"); // dropped: map full
    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(true);
    expect(limiter.isBlocked("c")).toBe(false);
    // Existing keys keep counting even when the map is full.
    limiter.recordFailure("a");
    expect(limiter.isBlocked("a")).toBe(true);
  });
});
