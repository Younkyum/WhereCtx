/**
 * Place rules: how long to stay before an arrival or a departure counts, an
 * approach distance, which events a place records, whether webhooks and
 * reminders hear about it, and the place's outline. Mounted from the Places
 * view as a list; each place's rules are edited in a dialog that saves the
 * whole place, shape included, so nothing is reset.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useState } from "react";
import { haversineMeters } from "../../../src/geofence/distance";
import { polygonCentroid } from "../../../src/geofence/polygon";
import { DEFAULT_PLACE_RULES, PLACE_EVENT_TYPES, type PlaceEventType } from "../../../src/types";
import { api } from "../api";
import { useApp } from "../context";
import { outlineText, parseOutline } from "../lib";
import { oneOf, type Place } from "../model";
import { DialogForm, Empty, FormDialog, Hint, Loaded, Panel, Row, Rows, useNotify, type Load } from "../ui";

const MAX_DWELL_MIN = 1440;
const DEFAULT_APPROACH_M = 500;
const MAX_RADIUS_M = 100_000;
/** A new outline centred farther than this from the place probably has its numbers in "lon, lat" order. */
const SWAP_SUSPECT_M = 100_000;
const SHAPES = ["circle", "polygon"] as const;
type Shape = (typeof SHAPES)[number];

export function PlaceRules({ state, onSaved }: { state: Load<Place[]>; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const place = state.kind === "ready" ? state.data.find((p) => p.name === editing) : undefined;
  const close = () => setEditing(null);
  return (
    <Panel title={t("placeRules.title")}>
      <Loaded state={state}>
        {(list) =>
          list.length ? (
            <Rows items={list} keyOf={(p) => p.name}>
              {(p) => (
                <Row title={p.name} subtitle={<RulesSummary place={p} />}>
                  <Button label={t("placeRules.edit")} size="sm" onClick={() => setEditing(p.name)} />
                </Row>
              )}
            </Rows>
          ) : (
            <Empty text={t("places.empty")} />
          )
        }
      </Loaded>
      <FormDialog isOpen={place !== undefined} onClose={close}>
        {place ? <RulesForm place={place} onClose={close} onSaved={onSaved} /> : null}
      </FormDialog>
    </Panel>
  );
}

function RulesSummary({ place }: { place: Place }) {
  const { t } = useApp();
  const rules = { ...DEFAULT_PLACE_RULES, ...place };
  const notes = [
    t("placeRules.summaryWait", { enter: rules.enterAfterSec / 60, exit: rules.exitAfterSec / 60 }),
    ...(rules.approachM === null ? [] : [t("placeRules.summaryApproach", { m: rules.approachM })]),
    ...(rules.notifyWebhooks ? [] : [t("placeRules.summaryQuiet")]),
    ...(rules.notifyReminders ? [] : [t("placeRules.summaryNoReminders")]),
  ];
  return (
    <VStack gap={1}>
      <HStack gap={1} wrap="wrap">
        <Badge variant="neutral" label={t(`ptype.${place.type}`)} />
        <Badge variant="info" label={t(place.polygon ? "placeRules.polygon" : "placeRules.circle")} />
      </HStack>
      <Text type="supporting">{notes.join(" · ")}</Text>
    </VStack>
  );
}

function RulesForm({ place, onClose, onSaved }: { place: Place; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const rules = { ...DEFAULT_PLACE_RULES, ...place };
  const [enterMin, setEnterMin] = useState<number | null>(rules.enterAfterSec / 60);
  const [exitMin, setExitMin] = useState<number | null>(rules.exitAfterSec / 60);
  const [watchApproach, setWatchApproach] = useState(rules.approachM !== null);
  const [approachM, setApproachM] = useState<number | null>(rules.approachM ?? DEFAULT_APPROACH_M);
  const [emits, setEmits] = useState<string[]>([...rules.emits]);
  const [notifyWebhooks, setNotifyWebhooks] = useState(rules.notifyWebhooks);
  const [notifyReminders, setNotifyReminders] = useState(rules.notifyReminders);
  const [shape, setShape] = useState<Shape>(place.polygon ? "polygon" : "circle");
  // A polygon place's lat/lon/radiusM are its centroid and circumradius, so switching it to a circle starts there.
  const [lat, setLat] = useState<number | null>(place.lat);
  const [lon, setLon] = useState<number | null>(place.lon);
  const [radiusM, setRadiusM] = useState<number | null>(place.radiusM);
  const [vertices, setVertices] = useState(place.polygon ? outlineText(place.polygon) : "");

  const outline = parseOutline(vertices);
  const geometry =
    shape === "polygon"
      ? outline.kind === "ring"
        ? { polygon: outline.ring }
        : null
      : lat != null && Math.abs(lat) <= 90 && lon != null && Math.abs(lon) <= 180 && radiusM != null && radiusM > 0 && radiusM <= MAX_RADIUS_M
        ? { lat, lon, radiusM }
        : null;
  const outlineProblem =
    outline.kind === "badLine"
      ? t("placeRules.badLine", { n: outline.line })
      : outline.kind === "repeated"
        ? t("placeRules.repeated", { n: outline.line })
        : outline.kind === "tooFew"
          ? t("placeRules.tooFew")
          : null;
  const centre = outline.kind === "ring" ? polygonCentroid(outline.ring) : null;
  const awayM = centre ? haversineMeters(place.lat, place.lon, centre.lat, centre.lon) : 0;
  const outlineStatus = outlineProblem
    ? ({ type: "error", message: outlineProblem } as const)
    : awayM > SWAP_SUSPECT_M
      ? ({ type: "warning", message: t("placeRules.farAway", { km: Math.round(awayM / 1000) }) } as const)
      : undefined;
  const minutesOk = (m: number | null) => m != null && m >= 0 && m <= MAX_DWELL_MIN;
  const rulesOk =
    minutesOk(enterMin) && minutesOk(exitMin) && (!watchApproach || (approachM != null && approachM >= 10 && approachM <= 50_000));

  const save = async () => {
    await api("/v1/places", {
      body: {
        name: place.name,
        type: place.type,
        ...(place.label ? { label: place.label } : {}),
        ...geometry,
        enterAfterSec: Math.round(enterMin! * 60),
        exitAfterSec: Math.round(exitMin! * 60),
        approachM: watchApproach ? approachM : null,
        emits: emits.filter((e): e is PlaceEventType => oneOf(PLACE_EVENT_TYPES, e)),
        notifyWebhooks,
        notifyReminders,
      },
    });
    notify.ok(t("toast.saved"));
    await onSaved();
  };

  return (
    <DialogForm
      title={t("placeRules.dialogTitle", { name: place.name })}
      submitLabel={t("common.save")}
      canSubmit={rulesOk && geometry !== null}
      onSubmit={save}
      onClose={onClose}
    >
      <Grid columns={{ minWidth: 180, max: 2 }} gap={3}>
        <NumberInput
          label={t("placeRules.enterAfter")}
          description={t("placeRules.enterAfterDesc")}
          value={enterMin}
          onChange={setEnterMin}
          min={0}
          max={MAX_DWELL_MIN}
          step={1}
          units={t("placeRules.minutes")}
        />
        <NumberInput
          label={t("placeRules.exitAfter")}
          description={t("placeRules.exitAfterDesc")}
          value={exitMin}
          onChange={setExitMin}
          min={0}
          max={MAX_DWELL_MIN}
          step={1}
          units={t("placeRules.minutes")}
        />
      </Grid>
      <HStack gap={3} vAlign="end" wrap="wrap">
        <CheckboxInput label={t("placeRules.approach")} value={watchApproach} onChange={setWatchApproach} />
        {watchApproach ? (
          <NumberInput
            label={t("placeRules.approachM")}
            value={approachM}
            onChange={setApproachM}
            min={10}
            max={50_000}
            step={50}
            units="m"
            width={180}
          />
        ) : null}
      </HStack>
      <CheckboxList label={t("placeRules.emits")} value={emits} onChange={setEmits}>
        {PLACE_EVENT_TYPES.map((type) => (
          <CheckboxListItem key={type} value={type} label={t(`webhooks.event.${type}`)} />
        ))}
      </CheckboxList>
      <Switch label={t("placeRules.notifyWebhooks")} description={t("placeRules.notifyWebhooksDesc")} value={notifyWebhooks} onChange={setNotifyWebhooks} />
      <Switch label={t("placeRules.notifyReminders")} value={notifyReminders} onChange={setNotifyReminders} />
      <Hint>{t("placeRules.hint")}</Hint>
      <VStack gap={3}>
        <Heading level={3}>{t("placeRules.outline")}</Heading>
        <SegmentedControl label={t("placeRules.outline")} value={shape} onChange={(v) => oneOf(SHAPES, v) && setShape(v)}>
          <SegmentedControlItem value="circle" label={t("placeRules.circle")} />
          <SegmentedControlItem value="polygon" label={t("placeRules.polygon")} />
        </SegmentedControl>
        {shape === "polygon" ? (
          <VStack gap={1}>
            <TextArea
              label={t("placeRules.vertices")}
              description={t("placeRules.verticesDesc")}
              value={vertices}
              onChange={setVertices}
              rows={6}
              placeholder={"37.5665, 126.9780\n37.5670, 126.9790\n37.5660, 126.9795"}
              hasSpellCheck={false}
              status={outlineStatus}
            />
            {centre ? <Hint>{t("placeRules.centre", { lat: centre.lat.toFixed(4), lon: centre.lon.toFixed(4) })}</Hint> : null}
          </VStack>
        ) : (
          <Grid columns={{ minWidth: 150, max: 3 }} gap={3}>
            <NumberInput label={t("places.lat")} value={lat} onChange={setLat} min={-90} max={90} step={0.000001} isRequired />
            <NumberInput label={t("places.lon")} value={lon} onChange={setLon} min={-180} max={180} step={0.000001} isRequired />
            <NumberInput label={t("places.radius")} value={radiusM} onChange={setRadiusM} min={1} max={MAX_RADIUS_M} step={10} isRequired />
          </Grid>
        )}
      </VStack>
    </DialogForm>
  );
}
