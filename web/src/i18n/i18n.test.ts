import { describe, expect, it } from "vitest";
import { DICTIONARIES, translate } from ".";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dashboard copy", () => {
  it("has the same keys and placeholders in English and Korean, none empty", () => {
    const en = DICTIONARIES.en as Record<string, string>;
    const ko = DICTIONARIES.ko as Record<string, string>;
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(en[key]!.trim(), key).not.toBe("");
      expect(ko[key]!.trim(), key).not.toBe("");
      expect(placeholders(ko[key]!), key).toEqual(placeholders(en[key]!));
    }
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(translate("en", "gate.invite.desc", { workspace: "Family", role: "Admin" })).toBe("Join Family as Admin.");
    expect(translate("ko", "age.min", { n: 5 })).toBe(DICTIONARIES.ko["age.min"].replace("{n}", "5"));
    expect(translate("en", "age.min")).toBe("{n} min ago");
  });

  it("shows the custom status as a custom place, not the raw API value", () => {
    expect(DICTIONARIES.en["st.custom"]).toBe("At a custom place");
    expect(DICTIONARIES.ko["st.custom"]).toBe("지정 장소");
  });
});
