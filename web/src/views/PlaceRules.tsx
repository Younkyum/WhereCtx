/**
 * Place rules: how long to stay before an arrival or a departure counts, an
 * approach distance, which events a place records, and whether webhooks and
 * reminders hear about it. Mounted from the Places view; saves the whole
 * place, shape included, so nothing is reset.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { useState, type FormEvent } from "react";
import { DEFAULT_PLACE_RULES, PLACE_EVENT_TYPES, type PlaceEventType } from "../../../src/types";
import { api } from "../api";
import { useApp } from "../context";
import { oneOf, type Place } from "../model";
import { Empty, Hint, Loaded, Panel, useAction, useNotify, type Load } from "../ui";

const MAX_DWELL_MIN = 1440;
const DEFAULT_APPROACH_M = 500;

export function PlaceRules({ state, onSaved }: { state: Load<Place[]>; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  return (
    <Panel title={t("placeRules.title")}>
      <Loaded state={state}>
        {(list) => (list.length ? <RulesEditor places={list} onSaved={onSaved} /> : <Empty text={t("places.empty")} />)}
      </Loaded>
    </Panel>
  );
}

function RulesEditor({ places, onSaved }: { places: Place[]; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  const [name, setName] = useState(places[0]!.name);
  const place = places.find((p) => p.name === name) ?? places[0]!;
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="end" wrap="wrap">
        <Selector
          label={t("placeRules.place")}
          value={place.name}
          options={places.map((p) => ({ value: p.name, label: p.name }))}
          onChange={setName}
          width={220}
        />
        {place.polygon ? <Badge variant="info" label={t("placeRules.polygon")} /> : null}
      </HStack>
      <RulesForm key={`${place.name}|${place.updatedAt ?? ""}`} place={place} onSaved={onSaved} />
    </VStack>
  );
}

function RulesForm({ place, onSaved }: { place: Place; onSaved: () => Promise<void> }) {
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
  const minutesOk = (m: number | null) => m != null && m >= 0 && m <= MAX_DWELL_MIN;
  const valid =
    minutesOk(enterMin) && minutesOk(exitMin) && (!watchApproach || (approachM != null && approachM >= 10 && approachM <= 50_000));
  const [busy, save] = useAction(async () => {
    const shape = place.polygon ? { polygon: place.polygon } : { lat: place.lat, lon: place.lon, radiusM: place.radiusM };
    await api("/v1/places", {
      body: {
        name: place.name,
        type: place.type,
        ...(place.label ? { label: place.label } : {}),
        ...shape,
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
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) void save();
  };
  return (
    <form onSubmit={submit}>
      <VStack gap={3}>
        <Grid columns={{ minWidth: 180, max: 3 }} gap={3}>
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
        <HStack>
          <Button type="submit" label={t("common.save")} variant="primary" isLoading={busy} isDisabled={!valid} />
        </HStack>
      </VStack>
    </form>
  );
}
