import { createContext, useContext } from "react";
import type { Lang, Translate } from "./i18n";
import type { Me } from "./model";

export type ColorMode = "system" | "light" | "dark";

export interface AppContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  t: Translate;
  /** The signed-in person; null only on the sign-in screens. */
  me: Me | null;
  refreshMe: () => Promise<Me>;
  /** callServer is false when the session is already gone (its own row was deleted). */
  signOut: (callServer: boolean) => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside <AppContext>");
  return value;
}

/** The signed-in person, for views that only render inside the app shell. */
export function useMe() {
  const { me } = useApp();
  if (!me) throw new Error("useMe outside a session");
  return me;
}
