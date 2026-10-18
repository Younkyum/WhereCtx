/**
 * The app root: language and color mode, the session (booting, signed out,
 * signed in), the invite token from the address bar, and the shell with one
 * navigation table that feeds the desktop sidebar and the phone drawer.
 */

import { AppShell } from "@astryxdesign/core/AppShell";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import koCatalog from "@astryxdesign/core/locales/ko-KR.generated.js";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Theme } from "@astryxdesign/core/theme";
import { useToast } from "@astryxdesign/core/Toast";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import {
  Activity,
  Bot,
  House,
  Languages,
  MapPin,
  Share2,
  ShieldCheck,
  Smartphone,
  UserRound,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { api, setApiHooks } from "./api";
import { AppContext, useApp, type AppContextValue, type ColorMode } from "./context";
import { isLang, translate, type I18nKey, type Lang } from "./i18n";
import { parseInviteHash } from "./lib";
import type { Me } from "./model";
import { theme } from "./theme";
import { ConfirmProvider } from "./ui";
import { AccountView } from "./views/Account";
import { DevicesView, AgentsView } from "./views/Devices";
import { EventsView, PlacesView, PrivacyView, WebhooksView } from "./views/Data";
import { Gate, InviteAccept } from "./views/Gate";
import { HomeView } from "./views/Home";
import { SharingView } from "./views/Sharing";
import { WorkspaceView, selectWorkspace } from "./views/Workspace";

interface View {
  id: string;
  icon: LucideIcon;
  label: I18nKey;
  /** Shown in the main section; the rest sit under "More". */
  main: boolean;
  Component: ComponentType;
}

const VIEWS = [
  { id: "home", icon: House, label: "nav.home", main: true, Component: HomeView },
  { id: "sharing", icon: Share2, label: "nav.sharing", main: true, Component: SharingView },
  { id: "places", icon: MapPin, label: "nav.places", main: true, Component: PlacesView },
  { id: "devices", icon: Smartphone, label: "nav.devices", main: true, Component: DevicesView },
  { id: "agents", icon: Bot, label: "nav.agents", main: false, Component: AgentsView },
  { id: "privacy", icon: ShieldCheck, label: "nav.privacy", main: false, Component: PrivacyView },
  { id: "workspace", icon: Users, label: "nav.workspace", main: false, Component: WorkspaceView },
  { id: "account", icon: UserRound, label: "nav.account", main: false, Component: AccountView },
  { id: "events", icon: Activity, label: "nav.events", main: false, Component: EventsView },
  { id: "webhooks", icon: Webhook, label: "nav.webhooks", main: false, Component: WebhooksView },
] as const satisfies readonly View[];

type ViewId = (typeof VIEWS)[number]["id"];

function viewFor(hash: string): (typeof VIEWS)[number] {
  return VIEWS.find((v) => "#" + v.id === hash) ?? VIEWS[0];
}

type Session = { kind: "booting" } | { kind: "signedOut" } | { kind: "signedIn"; me: Me };

const LANG_KEY = "wherectx_lang";
const MODE_KEY = "wherectx_color_mode";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts until reload */
  }
}

function initialLang(): Lang {
  const saved = stored(LANG_KEY);
  if (isLang(saved)) return saved;
  return navigator.language.slice(0, 2) === "ko" ? "ko" : "en";
}

function initialMode(): ColorMode {
  const saved = stored(MODE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** Takes the invite token out of the address bar so it is not bookmarked or shared by accident. */
function takeInvite(): string | null {
  const token = parseInviteHash(location.hash);
  if (token) history.replaceState(null, "", location.pathname + location.search);
  return token;
}

export function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [colorMode, setColorModeState] = useState<ColorMode>(initialMode);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((next: Lang) => {
    store(LANG_KEY, next);
    setLangState(next);
  }, []);
  const setColorMode = useCallback((next: ColorMode) => {
    store(MODE_KEY, next);
    setColorModeState(next);
  }, []);
  return (
    <Theme theme={theme} mode={colorMode}>
      <InternationalizationProvider locale={lang === "ko" ? "ko-KR" : "en"} messages={{ "ko-KR": koCatalog }}>
        <SessionRoot lang={lang} setLang={setLang} colorMode={colorMode} setColorMode={setColorMode} />
      </InternationalizationProvider>
    </Theme>
  );
}

type Prefs = Pick<AppContextValue, "lang" | "setLang" | "colorMode" | "setColorMode">;

function SessionRoot(prefs: Prefs) {
  const toast = useToast();
  const t = useCallback<AppContextValue["t"]>((key, vars) => translate(prefs.lang, key, vars), [prefs.lang]);
  const [session, setSession] = useState<Session>({ kind: "booting" });
  const [invite, setInvite] = useState<string | null>(takeInvite);
  const [hash, setHash] = useState(location.hash);

  useEffect(() => {
    void api<Me>("/v1/me", { public: true }).then(
      (me) => setSession({ kind: "signedIn", me }),
      () => setSession({ kind: "signedOut" }),
    );
  }, []);

  useEffect(() => {
    const onHash = () => {
      const token = takeInvite();
      if (token) setInvite(token);
      else setHash(location.hash);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    setApiHooks({
      onSignedOut: () =>
        setSession((s) => {
          if (s.kind === "signedIn") toast({ body: t("err.sessionEnded"), type: "error" });
          return { kind: "signedOut" };
        }),
      onReauth: () => toast({ body: t("reauth.prompt") }),
    });
  }, [t, toast]);

  const refreshMe = useCallback(async () => {
    const me = await api<Me>("/v1/me");
    setSession({ kind: "signedIn", me });
    return me;
  }, []);

  const signOut = useCallback(
    async (callServer: boolean) => {
      if (callServer) await api("/v1/auth/logout", { method: "POST", public: true }).catch(() => undefined);
      toast({ body: t("account.signedOut") });
      setSession({ kind: "signedOut" });
    },
    [t, toast],
  );

  const me = session.kind === "signedIn" ? session.me : null;
  const value = useMemo<AppContextValue>(
    () => ({ ...prefs, t, me, refreshMe, signOut }),
    [prefs, t, me, refreshMe, signOut],
  );

  const view = viewFor(hash);
  useEffect(() => {
    document.title = me ? `${t(view.label)} · WhereCtx` : "WhereCtx";
  }, [me, t, view]);

  let body;
  if (session.kind === "booting") {
    body = (
      <Center minHeight="100dvh">
        <Spinner size="lg" label={t("common.loading")} />
      </Center>
    );
  } else if (session.kind === "signedOut") {
    body = (
      <Gate
        key={invite ?? ""}
        invite={invite}
        onSignedIn={(inviteUsed) => {
          if (inviteUsed) setInvite(null);
          void refreshMe();
        }}
      />
    );
  } else if (invite) {
    body = (
      <Shell route={null}>
        <InviteAccept
          token={invite}
          onClose={(next, workspaceId) => {
            if (workspaceId) selectWorkspace(workspaceId);
            setInvite(null);
            location.hash = "#" + next;
          }}
        />
      </Shell>
    );
  } else {
    body = (
      <Shell route={view.id}>
        <view.Component key={view.id} />
      </Shell>
    );
  }

  return (
    <AppContext.Provider value={value}>
      <ConfirmProvider>{body}</ConfirmProvider>
    </AppContext.Provider>
  );
}

/** Language and color mode, in the top bar and on the sign-in screens. */
export function DisplayMenu() {
  const { t, lang, setLang, colorMode, setColorMode } = useApp();
  const check = (on: boolean) => (on ? <Icon icon="check" size="sm" /> : undefined);
  const modes: ColorMode[] = ["system", "light", "dark"];
  return (
    <MoreMenu
      label={t("app.display")}
      icon={<Icon icon={Languages} />}
      alignment="end"
      items={[
        {
          type: "section",
          title: t("app.language"),
          items: [
            { label: "English", onClick: () => setLang("en"), endContent: check(lang === "en") },
            { label: "한국어", onClick: () => setLang("ko"), endContent: check(lang === "ko") },
          ],
        },
        {
          type: "section",
          title: t("theme.title"),
          items: modes.map((m) => ({ label: t(`theme.${m}`), onClick: () => setColorMode(m), endContent: check(colorMode === m) })),
        },
      ]}
    />
  );
}

function Shell({ route, children }: { route: ViewId | null; children: React.ReactNode }) {
  const { t, me } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    setNavOpen(false);
    window.scrollTo(0, 0);
  }, [route]);
  const items = (main: boolean) =>
    VIEWS.filter((v) => v.main === main).map((v) => (
      <SideNavItem key={v.id} label={t(v.label)} icon={v.icon} href={"#" + v.id} isSelected={v.id === route} />
    ));
  return (
    <AppShell
      height="auto"
      variant="section"
      mobileNav={{ isOpen: navOpen, onOpenChange: setNavOpen }}
      topNav={
        <TopNav
          label="WhereCtx"
          heading={<TopNavHeading heading="WhereCtx" subheading={t("app.subtitle")} headingHref="#home" logo={<Icon icon={MapPin} />} />}
          endContent={<DisplayMenu />}
        />
      }
      sideNav={
        <SideNav
          footer={
            me ? (
              <Text type="supporting" maxLines={1}>
                {me.user.displayName}
              </Text>
            ) : undefined
          }
        >
          <SideNavSection title={t("nav.section.main")} isHeaderHidden>
            {items(true)}
          </SideNavSection>
          <SideNavSection title={t("nav.more")}>{items(false)}</SideNavSection>
        </SideNav>
      }
    >
      <Layout height="auto" contentWidth={1040} content={<LayoutContent>{children}</LayoutContent>} />
    </AppShell>
  );
}
