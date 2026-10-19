/**
 * My status, "share my location now" (one browser geolocation fix posted as a
 * manual reading), and the people who share with me. Opening someone's exact
 * location is audited on their side.
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
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { useApp } from "../context";
import { geoErrorKey, motionOf, safeHttpUrl, statusOf } from "../lib";
import type { Eta, Person, Place, PreciseLocation, Presence, PrivacySettings } from "../model";
import { Empty, Hint, Loaded, Page, Panel, useAction, useFormat, useLoad, useNotify } from "../ui";

type Mine = { presence: Presence | null; problem: "none" | "hidden" | null; paused: boolean; toHome: Eta | null };

/**
 * Drive time to my home place, while maps are on and I am away from it.
 * One provider call per Home load; any refusal (no key, stale, no home place)
 * just leaves the line out.
 */
async function loadToHome(settings: PrivacySettings | undefined, presence: Presence | null): Promise<Eta | null> {
  if (!settings?.geoEnabled || !presence || presence.status === "home" || presence.status === "near_home") return null;
  const home = (await api<{ places: Place[] }>("/v1/places")).places?.find((p) => p.type === "home");
  if (!home) return null;
  try {
    return (await api<{ eta: Eta }>(`/v1/geo/eta?to=${encodeURIComponent(home.name)}`)).eta;
  } catch {
    return null;
  }
}

async function loadMine(): Promise<Mine> {
  const privacy = await api<{ settings: PrivacySettings }>("/v1/privacy");
  const paused = Boolean(privacy.settings?.sharingPaused);
  try {
    const presence = await api<Presence>("/v1/presence");
    return { presence, problem: null, paused, toHome: await loadToHome(privacy.settings, presence) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { presence: null, problem: "none", paused, toHome: null };
    if (e instanceof ApiError && e.status === 403) return { presence: null, problem: "hidden", paused, toHome: null };
    throw e;
  }
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

export function HomeView() {
  const { t } = useApp();
  const notify = useNotify();
  const [mine, reloadMine] = useLoad(loadMine, []);
  const [people, reloadPeople] = useLoad(() => api<{ people: Person[] }>("/v1/people").then((r) => r.people ?? []), []);
  useEffect(() => {
    const timer = setInterval(() => void reloadPeople(), 30000);
    return () => clearInterval(timer);
  }, [reloadPeople]);
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
    await reloadMine();
  });

  return (
    <Page title={t("home.title")}>
      <Card>
        <Loaded state={mine}>
          {(m) => <MyStatus mine={m} sharing={sharing} onShare={() => void shareNow()} />}
        </Loaded>
      </Card>
      <Panel title={t("people.title")}>
        <Loaded state={people}>
          {(list) =>
            list.length ? (
              <Grid columns={{ minWidth: 260, max: 3 }} gap={3}>
                {list.map((p) => (
                  <PersonCard key={p.user.id} person={p} />
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
    ? t("home.updated", { age: fmt.ago(Math.floor(p.updatedAgoSec / 60)) })
    : t(mine.problem === "hidden" ? "home.hiddenFromAgents" : "home.none");
  return (
    <HStack gap={4} wrap="wrap" vAlign="center">
      <StackItem size="fill">
        <VStack gap={1}>
          <Text type="supporting">{t("home.mine")}</Text>
          <Heading level={2}>{p ? t(`st.${statusOf(p.status)}`) : "—"}</Heading>
          {p?.area ? <Text>{p.area}</Text> : null}
          {mine.toHome ? (
            <Text weight="medium">
              {t(mine.toHome.trafficAware ? "home.toHomeLive" : "home.toHome", { min: mine.toHome.durationMin })}
            </Text>
          ) : null}
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting">{meta}</Text>
            {motion ? <Badge label={t(`motion.${motion}`)} /> : null}
            {mine.paused ? <Badge variant="warning" label={t("badge.pausedAll")} /> : null}
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

function PersonCard({ person: p }: { person: Person }) {
  const { t } = useApp();
  const fmt = useFormat();
  const [precise, setPrecise] = useState<Person | null>(null);
  const [opening, open] = useAction(async () => {
    const r = await api<{ person: Person }>("/v1/people/" + encodeURIComponent(p.user.id));
    setPrecise(r.person);
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
            <Text type="supporting">{fmt.ago(pr.updatedAgoMin)}</Text>
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
