/**
 * My own data: places, privacy (what agents see, and pausing people), and
 * presence events.
 */

import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@astryxdesign/core/Link";
import { ApiError, api } from "../api";
import { useApp } from "../context";
import type { Translate } from "../i18n";
import {
  AGENT_ACCESS,
  PLACE_TYPES,
  PRIVACY_FLAGS,
  oneOf,
  type AgentAccess,
  type GeoCandidate,
  type Place,
  type PlaceType,
  type PresenceEvent,
  type PrivacySettings,
} from "../model";
import { placesScene, type LatLon } from "../mapScene";
import { MapView, useMapTiles } from "../MapView";
import { DialogForm, Empty, FormDialog, Hint, Loaded, Page, Panel, Row, Rows, useAction, useConfirm, useLoad, useNotify } from "../ui";
import { PlaceRules } from "./PlaceRules";

function usePlaceTypes() {
  const { t } = useApp();
  return PLACE_TYPES.map((k) => ({ value: k, label: t(`ptype.${k}`) }));
}

type AddDialog = "address" | "here" | "coords" | null;

export function PlacesView() {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
  const [places, reload] = useLoad(() => api<{ places: Place[] }>("/v1/places").then((r) => r.places ?? []), []);
  const tiles = useMapTiles();
  const [picked, setPicked] = useState<LatLon | null>(null);
  const [adding, setAdding] = useState<AddDialog>(null);
  const list = places.kind === "ready" ? places.data : null;
  const scene = useMemo(() => placesScene(list ?? [], picked, t("map.picked")), [list, picked, t]);
  const remove = async (p: Place) => {
    if (!(await confirm({ title: t("places.deleteConfirm", { name: p.name }), action: t("common.delete") }))) return;
    try {
      await api(`/v1/places/${encodeURIComponent(p.name)}`, { method: "DELETE" });
      notify.ok(t("toast.deleted"));
    } catch (e) {
      notify.fail(e);
    }
    await reload();
  };
  const close = () => {
    setAdding(null);
    setPicked(null);
  };
  const added = async () => {
    notify.ok(t("toast.saved"));
    await reload();
  };
  const actions = (
    <HStack gap={2} wrap="wrap">
      <Button label={t("places.byAddress")} size="sm" onClick={() => setAdding("address")} />
      <Button label={t("places.addHere")} size="sm" onClick={() => setAdding("here")} />
      <Button label={t("places.byCoords")} size="sm" onClick={() => setAdding("coords")} />
    </HStack>
  );
  return (
    <Page title={t("places.title")} description={t("places.desc")}>
      <Panel title={t("places.list")} actions={actions}>
        <Loaded state={places}>
          {(list) =>
            list.length ? (
              <Table
                data={list.map((p) => ({ ...p }))}
                idKey="name"
                columns={[
                  { key: "name", header: t("places.name") },
                  { key: "type", header: t("places.type"), renderCell: (p) => t(`ptype.${p.type}`) },
                  { key: "lat", header: t("places.lat") },
                  { key: "lon", header: t("places.lon") },
                  { key: "radiusM", header: t("places.radius") },
                  {
                    key: "actions",
                    header: "",
                    align: "end",
                    renderCell: (p) => (
                      <Button label={t("common.delete")} variant="destructive" size="sm" clickAction={() => remove(p)} />
                    ),
                  },
                ]}
              />
            ) : (
              <Empty text={t("places.empty")} />
            )
          }
        </Loaded>
      </Panel>
      <MapView
        tiles={tiles}
        scene={scene}
        title={t("places.map")}
        hint={t("places.mapHint")}
        onPick={(at) => {
          setPicked(at);
          setAdding("coords");
        }}
      />
      <PlaceRules state={places} onSaved={reload} />
      <FormDialog isOpen={adding !== null} onClose={close}>
        {adding === "address" ? (
          <AddByAddress onClose={close} onAdded={added} />
        ) : adding === "here" ? (
          <AddHere onClose={close} onAdded={added} />
        ) : adding === "coords" ? (
          <AddByCoordinates picked={picked} onClose={close} onAdded={added} />
        ) : null}
      </FormDialog>
    </Page>
  );
}

/** Kakao Map's documented web link to a point (apis.map.kakao.com/web/guide, "지도 URL"). */
const mapLink = (c: GeoCandidate) => `https://map.kakao.com/link/map/${encodeURIComponent(c.label)},${c.lat},${c.lon}`;

interface AddProps {
  onClose: () => void;
  onAdded: () => Promise<void>;
}

function AddByAddress({ onClose, onAdded }: AddProps) {
  const { t } = useApp();
  const types = usePlaceTypes();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<GeoCandidate[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<GeoCandidate | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<PlaceType>("custom");
  const [searching, search] = useAction(async () => {
    setProblem(null);
    setChosen(null);
    try {
      setFound((await api<{ candidates: GeoCandidate[] }>(`/v1/geo/search?q=${encodeURIComponent(query.trim())}`)).candidates);
    } catch (e) {
      setFound(null);
      setProblem(
        e instanceof ApiError && e.status === 409
          ? t("places.byAddressNoKey")
          : e instanceof ApiError && e.status === 403
            ? t("places.byAddressMapsOff")
            : e instanceof Error
              ? e.message
              : String(e),
      );
    }
  });
  const save = async () => {
    if (!chosen) return;
    await api("/v1/places", { body: { name: name.trim(), type, lat: chosen.lat, lon: chosen.lon, label: chosen.label } });
    await onAdded();
  };
  return (
    <DialogForm
      title={t("places.byAddress")}
      submitLabel={t("places.save")}
      canSubmit={chosen !== null && name.trim() !== ""}
      onSubmit={save}
      onClose={onClose}
    >
      <HStack gap={2} wrap="wrap" vAlign="end">
        <TextInput label={t("places.byAddressQuery")} value={query} onChange={setQuery} width={320} />
        <Button label={t("places.byAddressSearch")} isLoading={searching} isDisabled={!query.trim()} onClick={() => void search()} />
      </HStack>
      <Hint>{t("places.byAddressHint")}</Hint>
      {problem ? <Text type="supporting">{problem}</Text> : null}
      {found && !found.length ? <Empty text={t("places.byAddressNone")} /> : null}
      {found?.length && !chosen ? (
        <Rows items={found} keyOf={(c) => `${c.lat},${c.lon},${c.label}`}>
          {(c) => (
            <Row title={c.label} subtitle={c.roadAddress && c.roadAddress !== c.label ? `${c.roadAddress} · ${c.address}` : c.address}>
              <Link href={mapLink(c)} isExternalLink>
                {t("places.viewOnMap")}
              </Link>
              <Button
                label={t("places.useThis")}
                size="sm"
                onClick={() => {
                  setChosen(c);
                  if (!name.trim()) setName(c.label.slice(0, 64));
                }}
              />
            </Row>
          )}
        </Rows>
      ) : null}
      {chosen ? (
        <VStack gap={2}>
          <Text>{t("places.chosen", { place: chosen.roadAddress ?? chosen.address })}</Text>
          <HStack gap={2} wrap="wrap" vAlign="end">
            <TextInput label={t("places.name")} value={name} onChange={setName} isRequired width={240} />
            <Selector label={t("places.type")} value={type} options={types} onChange={(v) => oneOf(PLACE_TYPES, v) && setType(v)} width={160} />
            <Button label={t("places.searchAgain")} onClick={() => setChosen(null)} />
          </HStack>
        </VStack>
      ) : null}
    </DialogForm>
  );
}

function AddHere({ onClose, onAdded }: AddProps) {
  const { t } = useApp();
  const types = usePlaceTypes();
  const [name, setName] = useState("");
  const [type, setType] = useState<PlaceType>("custom");
  const add = async () => {
    await api("/v1/places", { body: { name: name.trim(), type, useCurrentLocation: true } });
    await onAdded();
  };
  return (
    <DialogForm title={t("places.addHere")} submitLabel={t("places.addHereButton")} canSubmit={name.trim() !== ""} onSubmit={add} onClose={onClose}>
      <HStack gap={2} wrap="wrap" vAlign="end">
        <TextInput label={t("places.name")} value={name} onChange={setName} isRequired width={240} />
        <Selector label={t("places.type")} value={type} options={types} onChange={(v) => oneOf(PLACE_TYPES, v) && setType(v)} width={160} />
      </HStack>
      <Hint>{t("places.addHereHint")}</Hint>
    </DialogForm>
  );
}

/** `picked`: a point clicked on the map, which fills in the coordinates. */
function AddByCoordinates({ picked, onClose, onAdded }: AddProps & { picked: LatLon | null }) {
  const { t } = useApp();
  const types = usePlaceTypes();
  const [name, setName] = useState("");
  const [type, setType] = useState<PlaceType>("home");
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [radius, setRadius] = useState<number | null>(150);
  useEffect(() => {
    if (!picked) return;
    setLat(Number(picked.lat.toFixed(6)));
    setLon(Number(picked.lon.toFixed(6)));
  }, [picked]);
  const valid =
    name.trim() !== "" &&
    lat != null && lat >= -90 && lat <= 90 &&
    lon != null && lon >= -180 && lon <= 180 &&
    radius != null && radius >= 1;
  const save = async () => {
    await api("/v1/places", { body: { name: name.trim(), type, lat, lon, radiusM: radius } });
    await onAdded();
  };
  return (
    <DialogForm title={t("places.byCoords")} submitLabel={t("places.save")} canSubmit={valid} onSubmit={save} onClose={onClose}>
      <Grid columns={{ minWidth: 180, max: 2 }} gap={3}>
        <TextInput label={t("places.name")} value={name} onChange={setName} isRequired />
        <Selector label={t("places.type")} value={type} options={types} onChange={(v) => oneOf(PLACE_TYPES, v) && setType(v)} />
        <NumberInput label={t("places.lat")} value={lat} onChange={setLat} min={-90} max={90} step={0.000001} isRequired />
        <NumberInput label={t("places.lon")} value={lon} onChange={setLon} min={-180} max={180} step={0.000001} isRequired />
        <NumberInput label={t("places.radius")} value={radius} onChange={setRadius} min={1} step={10} isRequired />
      </Grid>
      <Hint>{t("places.byCoordsHint")}</Hint>
    </DialogForm>
  );
}

export function PrivacyView() {
  const { t } = useApp();
  const notify = useNotify();
  const [state, reload] = useLoad(() => api<{ settings: PrivacySettings }>("/v1/privacy").then((r) => r.settings), []);
  const [editing, setEditing] = useState(false);
  const close = () => setEditing(false);
  const pause = async (on: boolean) => {
    try {
      await api("/v1/privacy", { method: "PUT", body: { sharingPaused: on } });
      notify.ok(t(on ? "sharing.pausedOn" : "sharing.pausedOff"));
    } catch (e) {
      notify.fail(e);
    }
    await reload();
  };
  return (
    <Page title={t("privacy.title")} description={t("privacy.desc")}>
      <Loaded state={state}>
        {(s) => (
          <VStack gap={6}>
            <Panel title={t("privacy.agents")} actions={<Button label={t("privacy.edit")} variant="primary" onClick={() => setEditing(true)} />}>
              <Rows items={[...PRIVACY_SUMMARY]} keyOf={(k) => k}>
                {(k) => (
                  <Row title={t(`privacy.${k}`)}>
                    <Text>{privacyValue(s, k, t)}</Text>
                  </Row>
                )}
              </Rows>
            </Panel>
            <Panel title={t("privacy.people")}>
              <Switch label={t("sharing.pause.label")} description={t("privacy.peopleHint")} value={s.sharingPaused} changeAction={pause} />
            </Panel>
            <FormDialog isOpen={editing} onClose={close}>
              <EditPrivacy initial={s} onClose={close} onSaved={reload} />
            </FormDialog>
          </VStack>
        )}
      </Loaded>
    </Page>
  );
}

const PRIVACY_SUMMARY = ["defaultAgentAccess", ...PRIVACY_FLAGS, "retentionHours"] as const;

function privacyValue(s: PrivacySettings, k: (typeof PRIVACY_SUMMARY)[number], t: Translate): string {
  if (k === "defaultAgentAccess") return t(`access.${s.defaultAgentAccess}`);
  if (k === "retentionHours") return String(s.retentionHours);
  return t(s[k] ? "common.yes" : "common.no");
}

function EditPrivacy({ initial, onClose, onSaved }: { initial: PrivacySettings; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const [s, setS] = useState(initial);
  const save = async () => {
    const body: Partial<PrivacySettings> = { defaultAgentAccess: s.defaultAgentAccess, retentionHours: s.retentionHours };
    for (const k of PRIVACY_FLAGS) body[k] = s[k];
    await api("/v1/privacy", { method: "PUT", body });
    notify.ok(t("toast.saved"));
    await onSaved();
  };
  return (
    <DialogForm title={t("privacy.editTitle")} submitLabel={t("common.save")} canSubmit onSubmit={save} onClose={onClose}>
      <Selector
        label={t("privacy.defaultAgentAccess")}
        value={s.defaultAgentAccess}
        options={AGENT_ACCESS.map((k) => ({ value: k, label: t(`access.${k}`) }))}
        onChange={(v) => oneOf<AgentAccess>(AGENT_ACCESS, v) && setS({ ...s, defaultAgentAccess: v })}
      />
      <VStack gap={2}>
        {PRIVACY_FLAGS.map((k) => (
          <CheckboxInput key={k} label={t(`privacy.${k}`)} value={Boolean(s[k])} onChange={(on) => setS({ ...s, [k]: on })} />
        ))}
      </VStack>
      <NumberInput
        label={t("privacy.retentionHours")}
        value={s.retentionHours}
        onChange={(v) => setS({ ...s, retentionHours: v })}
        min={0}
        max={8760}
        isIntegerOnly
        width={200}
      />
    </DialogForm>
  );
}

export function EventsView() {
  const { t } = useApp();
  const [events] = useLoad(() => api<{ events: PresenceEvent[] }>("/v1/events?limit=50").then((r) => r.events ?? []), []);
  return (
    <Page title={t("events.title")} description={t("events.desc")}>
      <Panel title={t("events.recent")}>
        <Loaded state={events}>
          {(list) =>
            list.length ? (
              <Table
                data={list.map((e, i) => ({ ...e, key: e.id ?? String(i) }))}
                idKey="key"
                columns={[
                  { key: "type", header: t("events.type"), renderCell: (e) => <Text type="code">{e.type}</Text> },
                  { key: "placeName", header: t("events.place"), renderCell: (e) => e.placeName ?? "" },
                  { key: "createdAt", header: t("events.when"), renderCell: (e) => <Timestamp value={e.createdAt} format="date_time" /> },
                ]}
              />
            ) : (
              <Empty text={t("events.empty")} />
            )
          }
        </Loaded>
      </Panel>
    </Page>
  );
}
