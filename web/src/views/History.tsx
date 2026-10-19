/**
 * My own location history, when I keep it: the last hour, 6 or 24 hours, or a
 * day, as a track with my places as circles, and the same points as a
 * timeline. With a map key the track is drawn on the provider's map;
 * without one it is drawn from the points alone and no tiles are loaded.
 * Each point links out to a map. Only the signed-in person's own history is
 * ever shown here.
 */

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { DateInput, type DateInputProps } from "@astryxdesign/core/DateInput";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { drawTrack, groupByDay, historyQuery, localDay, mapLink, shiftDay, type HistoryRange } from "../lib";
import { historyScene } from "../mapScene";
import { MapView, useMapTiles } from "../MapView";
import { HISTORY_MAX_POINTS, type History, type HistoryPoint, type Place } from "../model";
import { Empty, Hint, Loaded, Page, Panel, Row, Rows, useFormat, useLoad } from "../ui";

type IsoDay = NonNullable<DateInputProps["value"]>;

const CHOICES = ["1", "6", "24", "day"] as const;
type Choice = (typeof CHOICES)[number];
const choiceOf = (range: HistoryRange): Choice => (range.kind === "day" ? "day" : (String(range.hours) as Choice));
const rangeKey = (range: HistoryRange): string => (range.kind === "day" ? range.day : `${range.hours}h`);

export function HistoryView() {
  const { t } = useApp();
  const [range, setRange] = useState<HistoryRange>({ kind: "recent", hours: 24 });
  const [state] = useLoad(
    async () => {
      const [history, places] = await Promise.all([
        api<History>(`/v1/presence/history${historyQuery(range, new Date(), HISTORY_MAX_POINTS)}`),
        api<{ places: Place[] }>("/v1/places").then((r) => r.places ?? []),
      ]);
      return { history, places };
    },
    [rangeKey(range)],
  );
  const today = localDay(new Date());
  const day = range.kind === "day" ? range.day : today;
  return (
    <Page title={t("history.title")} description={t("history.desc")}>
      <Loaded state={state}>
        {({ history, places }) =>
          history.enabled || history.points.length > 0 ? (
            <>
              <Panel title={t("history.range")}>
                <VStack gap={3}>
                  <SegmentedControl
                    label={t("history.range")}
                    value={choiceOf(range)}
                    onChange={(v) => {
                      if (v === "day") setRange({ kind: "day", day });
                      else if (v === "1" || v === "6" || v === "24") setRange({ kind: "recent", hours: Number(v) as 1 | 6 | 24 });
                    }}
                  >
                    <SegmentedControlItem value="1" label={t("history.last1")} />
                    <SegmentedControlItem value="6" label={t("history.last6")} />
                    <SegmentedControlItem value="24" label={t("history.last24")} />
                    <SegmentedControlItem value="day" label={t("history.day")} />
                  </SegmentedControl>
                  {range.kind === "day" ? (
                    <HStack gap={2} wrap="wrap" vAlign="end">
                      <Button label={t("history.prev")} onClick={() => setRange({ kind: "day", day: shiftDay(day, -1) })} />
                      <DateInput
                        label={t("history.pickDay")}
                        value={day as IsoDay}
                        max={today as IsoDay}
                        onChange={(v) => v && setRange({ kind: "day", day: v })}
                        width={200}
                      />
                      <Button
                        label={t("history.next")}
                        isDisabled={day >= today}
                        onClick={() => setRange({ kind: "day", day: shiftDay(day, 1) })}
                      />
                    </HStack>
                  ) : null}
                  <Hint>{t("history.retention", { n: history.retentionHours })}</Hint>
                </VStack>
              </Panel>
              {history.enabled ? null : <HistoryOff stillHasPoints />}
              <TrackMap points={history.points} places={places} />
              <Panel title={t("history.timeline")}>
                <VStack gap={3}>
                  {history.truncated ? <Banner status="info" title={t("history.truncated", { n: history.points.length })} /> : null}
                  <Timeline points={history.points} />
                </VStack>
              </Panel>
            </>
          ) : (
            <HistoryOff />
          )
        }
      </Loaded>
    </Page>
  );
}

function HistoryOff({ stillHasPoints = false }: { stillHasPoints?: boolean }) {
  const { t } = useApp();
  return (
    <Banner
      status={stillHasPoints ? "warning" : "info"}
      title={t(stillHasPoints ? "history.offKept.title" : "history.off.title")}
      description={t(stillHasPoints ? "history.offKept.desc" : "history.off.desc")}
      collapsible={false}
    >
      <HStack>
        <Button label={t("history.off.action")} href="#privacy" />
      </HStack>
    </Banner>
  );
}

function TrackMap({ points, places }: { points: HistoryPoint[]; places: Place[] }) {
  const { t } = useApp();
  const tiles = useMapTiles();
  const scene = useMemo(() => historyScene(points, places, t("map.latest")), [points, places, t]);
  const drawn = (
    <Panel title={t("history.map")}>
      <Track points={points} places={places} />
    </Panel>
  );
  return points.length ? <MapView tiles={tiles} scene={scene} title={t("history.map")} fallback={drawn} height={400} /> : drawn;
}

function Track({ points, places }: { points: HistoryPoint[]; places: Place[] }) {
  const { t } = useApp();
  const drawing = drawTrack(points, places);
  if (!drawing) return <Empty text={t("history.empty")} />;
  const last = drawing.dots.at(-1)!;
  return (
    <svg
      role="img"
      aria-label={t("history.mapAlt", { n: points.length })}
      viewBox={`0 0 ${drawing.width} ${drawing.height}`}
      width="100%"
      style={{ display: "block", maxWidth: drawing.width, borderRadius: 8, background: "var(--color-background-muted)" }}
    >
      {drawing.places.map((p) => (
        <g key={p.name}>
          <circle
            cx={p.x}
            cy={p.y}
            r={Math.max(p.r, 3)}
            style={{ fill: "var(--color-accent-muted)", stroke: "var(--color-border-emphasized)", strokeWidth: 1 }}
          />
          <text x={p.x} y={p.y - Math.max(p.r, 3) - 4} textAnchor="middle" style={{ fill: "var(--color-text-secondary)", fontSize: 12 }}>
            {p.name}
          </text>
        </g>
      ))}
      <path
        d={drawing.line}
        style={{ fill: "none", stroke: "var(--color-accent)", strokeWidth: 2.5, strokeLinejoin: "round", strokeLinecap: "round" }}
      />
      {drawing.dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={2.5} style={{ fill: "var(--color-accent)" }} />
      ))}
      <circle cx={last.x} cy={last.y} r={6} style={{ fill: "var(--color-accent)", stroke: "var(--color-background-card)", strokeWidth: 2 }} />
    </svg>
  );
}

function Timeline({ points }: { points: HistoryPoint[] }) {
  const { t, lang } = useApp();
  const format = useFormat();
  if (points.length === 0) return <Empty text={t("history.empty")} />;
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  const newestFirst = [...points].reverse();
  return (
    <VStack gap={4}>
      {groupByDay(newestFirst, (p) => p.recordedAt).map((group) => (
        <VStack key={group.day} gap={1}>
          <Heading level={3}>{format.date(group.items[0]!.recordedAt)}</Heading>
          <Rows items={group.items} keyOf={(p) => p.id}>
            {(p) => (
              <Row
                title={
                  <HStack gap={2} wrap="wrap">
                    <Text hasTabularNumbers>{clock(p.recordedAt)}</Text>
                    <Text>{p.place ? t("history.atPlace", { place: p.place }) : t("history.coords", { lat: p.lat.toFixed(5), lon: p.lon.toFixed(5) })}</Text>
                  </HStack>
                }
                subtitle={[p.accuracyM != null ? t("history.accuracy", { n: Math.round(p.accuracyM) }) : null, p.source].filter(Boolean).join(" · ")}
              >
                <Link href={mapLink(p.lat, p.lon)} isExternalLink>
                  {t("history.openMap")}
                </Link>
              </Row>
            )}
          </Rows>
        </VStack>
      ))}
    </VStack>
  );
}
