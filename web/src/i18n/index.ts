import { EN, type I18nKey } from "./en";
import { KO } from "./ko";

export type { I18nKey };
export type Lang = "en" | "ko";
export type Vars = Record<string, string | number>;
export type Translate = (key: I18nKey, vars?: Vars) => string;

export const DICTIONARIES: Record<Lang, Record<I18nKey, string>> = { en: EN, ko: KO };

/** Fills `{name}` placeholders; an unknown placeholder stays visible rather than vanishing. */
export function translate(lang: Lang, key: I18nKey, vars?: Vars): string {
  const text = DICTIONARIES[lang][key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] == null ? m : String(vars[name])));
}

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "ko";
}
