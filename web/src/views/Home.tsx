/**
 * My status, "share my location now" (one browser geolocation fix posted as a
 * manual reading), the drive time home when I ask for it, and the people who
 * share with me. Opening someone's exact location is audited on their side.
 *
 * With a map key, a map shows where I am and each person whose exact
 * location I opened here; nobody else is placed on it. An opened person
 * stays on it for OPENED_TTL_MS at most, and leaves as soon as the people
 * list stops saying their exact location is available. While I am near home
 * and the provider is kept away from there, the map shows my home place,
 * not my point.
 */

import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api";
import { useApp } from "../context";
import { geoErrorKey, motionOf, safeHttpUrl, statusOf } from "../lib";
import type { Eta, MyPoint, Person, Place, PreciseLocation, Presence, PrivacySettings } from "../model";
import { homeScene } from "../mapScene";
import { MapView, useMapConfig } from "../MapView";
import { Empty, Hint, Loaded, Page, Panel, useAction, useFormat, useLoad, useNotify } from "../ui";

type Mine = { presence: Presence | null; paused: boolean; geoEnabled: boolean; hiddenFromAgents: boolean };

/** My own status; I read it whatever agents may. */
async function loadMine(): Promise<Mine> {
  const { settings } = await api<{ settings: PrivacySettings }>("/v1/privacy");
  const flags = { paused: Boolean(settings?.sharingPaused), geoEnabled: Boolean(settings?.geoEnabled), hiddenFromAgents: settings?.defaultAgentAccess === "hidden" };
  try {
    return { presence: await api<Presence>("/v1/presence"), ...flags };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { presence: null, ...flags };
    throw e;
  }
}

/** Drive time to my home place, asked only when I press the button: one provider call each time. */
async function timeToHome(): Promise<Eta | null> {
  const home = (await api<{ places: Place[] }>("/v1/places")).places?.find((p) => p.type === "home");
  if (!home) return null;
  return (await api<{ eta: Eta }>(`/v1/geo/eta?to=${encodeURIComponent(home.name)}`)).eta;
}

function locate(t: ReturnType<typeof useApp>["t"]): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error(t("geo.unavailable")));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(t(geoErrorKey(e?.code)))), {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0,
    });
  });
}

/** How often the people list (and my point on the map) is read again. */
const REFRESH_MS = 30_000;
/** How long an opened person stays on the map: an exact location is a moment, not a feed. */
export const OPENED_TTL_MS = 5 * 60_000;

/** A person whose exact location I opened, and when. */
type Opened = { person: Person; at: PreciseLocation; openedAt: number };

export function HomeView() {
  const { t } = useApp();
  const fmt = useFormat();
  const notify = useNotify();
  const [mine, reloadMine] = useLoad(loadMine, []);
  const mapConfig = useMapConfig();
  const mapped = Boolean(mapConfig?.provider);
  // My point is read only for a map that will be drawn.
  const [myPoint, reloadMyPoint] = useLoad(
    () => (mapped ? api<MyPoint>("/v1/presence/precise").catch(() => null) : Promise.resolve(null)),
    [mapped],
  );
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [now, setNow] = useState(() => Date.now());
  const [people, reloadPeople] = useLoad(() => api<{ people: Person[] }>("/v1/people").then((r) => r.people ?? []), []);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      void reloadPeople();
      if (mapped) void reloadMyPoint();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reloadPeople, reloadMyPoint, mapped]);
  const list = people.kind === "ready" ? people.data : null;
  useEffect(() => {
    setOpened((o) => {
      const kept = Object.fromEntries(
        Object.entries(o).filter(
          ([id, entry]) => now - entry.openedAt < OPENED_TTL_MS && (!list || list.find((p) => p.user.id === id)?.precise === "available"),
        ),
      );
      return Object.keys(kept).length === Object.keys(o).length ? o : kept;
    });
  }, [list, now]);
  const [sharing, shareNow] = useAction(async () => {
    const pos = await locate(t);
    const r = await api<{ status: string }>("/v1/ingest", {
      body: {
        source: "manual",
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracyM: Math.round(pos.coords.accuracy),
        timestamp: new Date(pos.timestamp).toISOString(),
      },
    });
    notify.ok(t("home.shared", { status: t(`st.${statusOf(r.status)}`) }));
    await Promise.all([reloadMine(), reloadMyPoint()]);
  });
  const me = myPoint.kind === "ready" ? myPoint.data : null;
  const scene = useMemo(
    () =>
      homeScene(
        me?.nearHome
          ? { kind: "nearHome", place: me.nearHome }
          : me
            ? { kind: "point", at: { lat: me.lat, lon: me.lon }, title: t("map.me") }
            : null,
        Object.values(opened).map(({ person, at, openedAt }) => ({
          id: person.user.id,
          at: { lat: at.lat, lon: at.lon },
          title: `${person.user.displayName} · ${fmt.ago(at.updatedAgoMin + Math.floor(Math.max(0, now - openedAt) / 60_000))}`,
        })),
      ),
    // fmt follows t (the language); it is a new object each render.
    [me, opened, now, t],
  );
  const open = (person: Person) => {
    if (person.precise && typeof person.precise === "object") {
      const at = person.precise;
      setOpened((o) => ({ ...o, [person.user.id]: { person, at, openedAt: Date.now() } }));
    }
  };

  return (
    <Page title={t("home.title")}>
      <Card>
        <Loaded state={mine}>
          {(m) => <MyStatus mine={m} sharing={sharing} onShare={() => void shareNow()} />}
        </Loaded>
      </Card>
      <MapView config={mapConfig} scene={scene} hint={me?.nearHome ? t("map.nearHome", { place: me.nearHome.name }) : undefined} />
      <Panel title={t("people.title")}>
        <Loaded state={people}>
          {(list) =>
            list.length ? (
              <Grid columns={{ minWidth: 260, max: 3 }} gap={3}>
                {list.map((p) => (
                  <PersonCard key={p.user.id} person={p} opened={opened[p.user.id]?.person ?? null} onOpened={open} />
                ))}
              </Grid>
            ) : (
              <Empty text={t("people.empty")} />
            )
          }
        </Loaded>
      </Panel>
    </Page>
  );
}

function MyStatus({ mine, sharing, onShare }: { mine: Mine; sharing: boolean; onShare: () => void }) {
  const { t } = useApp();
  const fmt = useFormat();
  const p = mine.presence;
  const motion = p ? motionOf(p.motion) : null;
  const meta = p
    ? t("home.updated", { age: fmt.ago(Math.floor(p.updatedAgoSec / 60)) }) + (p.freshness === "offline" ? ` · ${t("home.offline")}` : "")
    : t("home.none");
  return (
    <HStack gap={4} wrap="wrap" vAlign="center">
      <StackItem size="fill">
        <VStack gap={1}>
          <Text type="supporting">{t("home.mine")}</Text>
          <Heading level={2}>{p ? t(`st.${statusOf(p.status)}`) : "—"}</Heading>
          {p?.area ? <Text>{p.area}</Text> : null}
          {mine.geoEnabled && p && p.status !== "home" ? <ToHome /> : null}
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting">{meta}</Text>
            {motion ? <Badge label={t(`motion.${motion}`)} /> : null}
            {mine.paused ? <Badge variant="warning" label={t("badge.pausedAll")} /> : null}
            {mine.hiddenFromAgents ? <Badge variant="warning" label={t("badge.hiddenFromAgents")} /> : null}
          </HStack>
        </VStack>
      </StackItem>
      <VStack gap={1} maxWidth={320}>
        <Button label={t("home.shareNow")} variant="primary" isLoading={sharing} onClick={onShare} />
        <Hint>{t(mine.paused ? "home.shareNowPaused" : "home.shareNowHint")}</Hint>
      </VStack>
    </HStack>
  );
}

function ToHome() {
  const { t } = useApp();
  const [eta, setEta] = useState<Eta | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, check] = useAction(async () => {
    setProblem(null);
    try {
      setEta(await timeToHome());
    } catch (e) {
      setEta(undefined);
      setProblem(e instanceof Error ? e.message : String(e));
    }
  });
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button label={t("home.checkToHome")} size="sm" isLoading={checking} onClick={() => void check()} />
        {eta ? (
          <Text weight="medium">
            {t(eta.traffic === "live" ? "home.toHomeLive" : "home.toHome", { min: eta.durationMin })}
            {eta.origin === "home" ? ` · ${t("maps.from.home")}` : ""}
          </Text>
        ) : eta === null ? (
          <Text type="supporting">{t("home.noHomePlace")}</Text>
        ) : null}
      </HStack>
      {problem ? <Text type="supporting">{problem}</Text> : <Hint>{t("home.checkToHomeHint")}</Hint>}
    </VStack>
  );
}

/**
 * `opened`: the person as read with their exact location (an audited read on
 * their side), while it is still shown; `onOpened` gets each such read.
 */
function PersonCard({ person: p, opened: precise, onOpened }: { person: Person; opened: Person | null; onOpened: (person: Person) => void }) {
  const { t } = useApp();
  const fmt = useFormat();
  const [opening, open] = useAction(async () => {
    const r = await api<{ person: Person }>("/v1/people/" + encodeURIComponent(p.user.id));
    onOpened(r.person);
  });
  const pr = p.presence;
  const motion = pr ? motionOf(pr.motion) : null;
  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={3} vAlign="center">
          <Avatar name={p.user.displayName} tooltip={false} />
          <StackItem size="fill">
            <VStack gap={0}>
              <Text weight="semibold" maxLines={1}>
                {p.user.displayName}
              </Text>
              <Text type="supporting">{t(`level.${p.level}`)}</Text>
            </VStack>
          </StackItem>
        </HStack>
        {p.paused || !pr ? (
          <Text color="secondary">{t(p.paused ? "people.paused" : "people.noReading")}</Text>
        ) : (
          <VStack gap={1}>
            <Text weight="medium">{t(`st.${statusOf(pr.status)}`)}</Text>
            {pr.area ? <Text>{pr.area}</Text> : null}
            <Text type="supporting">
              {fmt.ago(pr.updatedAgoMin) + (pr.freshness === "offline" ? ` · ${t("home.offline")}` : "")}
            </Text>
            <HStack gap={1} wrap="wrap">
              {motion ? <Badge label={t(`motion.${motion}`)} /> : null}
              {p.precise === "available" ? <Badge variant="info" label={t("badge.preciseAvailable")} /> : null}
            </HStack>
          </VStack>
        )}
        {!p.paused && pr && p.precise === "available" && !precise ? (
          <Button label={t("people.showPrecise")} size="sm" isLoading={opening} onClick={() => void open()} />
        ) : null}
        {!p.paused && pr && p.precise !== "available" && p.preciseWithheld ? (
          <Hint>{t(`people.withheld.${p.preciseWithheld}`)}</Hint>
        ) : null}
        {precise ? <PreciseBlock person={precise} /> : null}
      </VStack>
    </Card>
  );
}

function PreciseBlock({ person }: { person: Person }) {
  const { t } = useApp();
  const fmt = useFormat();
  const c = person.precise;
  if (!c || typeof c !== "object") {
    return <Hint>{t(person.preciseWithheld ? `people.withheld.${person.preciseWithheld}` : "people.preciseGone")}</Hint>;
  }
  const at: PreciseLocation = c;
  const url = safeHttpUrl(at.mapUrl);
  return (
    <VStack gap={1}>
      <HStack gap={2} wrap="wrap" vAlign="center">
        <Code>{`${Number(at.lat).toFixed(5)}, ${Number(at.lon).toFixed(5)}`}</Code>
        {at.accuracyM != null ? <Text type="supporting">±{Math.round(at.accuracyM)} m</Text> : null}
        <Text type="supporting">{fmt.ago(at.updatedAgoMin)}</Text>
        {url ? (
          <Link href={url} isExternalLink>
            {t("people.openMap")}
          </Link>
        ) : null}
      </HStack>
      <Hint>{t("people.audited", { name: person.user.displayName })}</Hint>
    </VStack>
  );
}
