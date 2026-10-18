/**
 * My own data: places, privacy (what agents see, and pausing people), presence
 * events, and webhooks with their failed deliveries.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useApp } from "../context";
import {
  AGENT_ACCESS,
  PLACE_TYPES,
  PRIVACY_FLAGS,
  oneOf,
  type AgentAccess,
  type DeadLetter,
  type Place,
  type PlaceType,
  type PresenceEvent,
  type PrivacySettings,
  type Webhook,
} from "../model";
import { Empty, Hint, Loaded, Page, Panel, useAction, useConfirm, useLoad, useNotify } from "../ui";

function usePlaceTypes() {
  const { t } = useApp();
  return PLACE_TYPES.map((k) => ({ value: k, label: t(`ptype.${k}`) }));
}

export function PlacesView() {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
  const [places, reload] = useLoad(() => api<{ places: Place[] }>("/v1/places").then((r) => r.places ?? []), []);
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
  return (
    <Page title={t("places.title")} description={t("places.desc")}>
      <Panel title={t("places.list")}>
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
      <AddHere onAdded={reload} />
      <AddByCoordinates onAdded={reload} />
    </Page>
  );
}

function AddHere({ onAdded }: { onAdded: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const types = usePlaceTypes();
  const [name, setName] = useState("");
  const [type, setType] = useState<PlaceType>("custom");
  const [busy, add] = useAction(async () => {
    await api("/v1/places", { body: { name: name.trim(), type, useCurrentLocation: true } });
    notify.ok(t("toast.saved"));
    setName("");
    await onAdded();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void add();
  };
  return (
    <Panel title={t("places.addHere")}>
      <form onSubmit={submit}>
        <VStack gap={2}>
          <HStack gap={2} wrap="wrap" vAlign="end">
            <TextInput label={t("places.name")} value={name} onChange={setName} isRequired width={240} />
            <Selector label={t("places.type")} value={type} options={types} onChange={(v) => oneOf(PLACE_TYPES, v) && setType(v)} width={160} />
            <Button type="submit" label={t("places.addHereButton")} variant="primary" isLoading={busy} isDisabled={!name.trim()} />
          </HStack>
          <Hint>{t("places.addHereHint")}</Hint>
        </VStack>
      </form>
    </Panel>
  );
}

function AddByCoordinates({ onAdded }: { onAdded: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const types = usePlaceTypes();
  const [name, setName] = useState("");
  const [type, setType] = useState<PlaceType>("home");
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [radius, setRadius] = useState<number | null>(150);
  const valid =
    name.trim() !== "" &&
    lat != null && lat >= -90 && lat <= 90 &&
    lon != null && lon >= -180 && lon <= 180 &&
    radius != null && radius >= 1;
  const [busy, save] = useAction(async () => {
    await api("/v1/places", { body: { name: name.trim(), type, lat, lon, radiusM: radius } });
    notify.ok(t("toast.saved"));
    setName("");
    setLat(null);
    setLon(null);
    setRadius(150);
    await onAdded();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) void save();
  };
  return (
    <Panel title={t("places.byCoords")}>
      <form onSubmit={submit}>
        <VStack gap={3}>
          <Grid columns={{ minWidth: 180, max: 3 }} gap={3}>
            <TextInput label={t("places.name")} value={name} onChange={setName} isRequired />
            <Selector label={t("places.type")} value={type} options={types} onChange={(v) => oneOf(PLACE_TYPES, v) && setType(v)} />
            <NumberInput label={t("places.radius")} value={radius} onChange={setRadius} min={1} step={10} isRequired />
            <NumberInput label={t("places.lat")} value={lat} onChange={setLat} min={-90} max={90} step={0.000001} isRequired />
            <NumberInput label={t("places.lon")} value={lon} onChange={setLon} min={-180} max={180} step={0.000001} isRequired />
          </Grid>
          <HStack>
            <Button type="submit" label={t("places.save")} variant="primary" isLoading={busy} isDisabled={!valid} />
          </HStack>
        </VStack>
      </form>
    </Panel>
  );
}

export function PrivacyView() {
  const { t } = useApp();
  const [state, reload] = useLoad(() => api<{ settings: PrivacySettings }>("/v1/privacy").then((r) => r.settings), []);
  return (
    <Page title={t("privacy.title")} description={t("privacy.desc")}>
      <Loaded state={state}>{(s) => <PrivacyForm initial={s} onSaved={reload} />}</Loaded>
    </Page>
  );
}

function PrivacyForm({ initial, onSaved }: { initial: PrivacySettings; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const [s, setS] = useState(initial);
  const [busy, save] = useAction(async () => {
    const body: Partial<PrivacySettings> = {
      defaultAgentAccess: s.defaultAgentAccess,
      retentionHours: s.retentionHours,
      sharingPaused: s.sharingPaused,
    };
    for (const k of PRIVACY_FLAGS) body[k] = s[k];
    await api("/v1/privacy", { method: "PUT", body });
    notify.ok(t("toast.saved"));
    await onSaved();
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <VStack gap={6}>
        <Panel title={t("privacy.agents")}>
          <VStack gap={4}>
            <Selector
              label={t("privacy.defaultAgentAccess")}
              value={s.defaultAgentAccess}
              options={AGENT_ACCESS.map((k) => ({ value: k, label: t(`access.${k}`) }))}
              onChange={(v) => oneOf<AgentAccess>(AGENT_ACCESS, v) && setS({ ...s, defaultAgentAccess: v })}
              width={260}
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
          </VStack>
        </Panel>
        <Panel title={t("privacy.people")}>
          <VStack gap={2}>
            <CheckboxInput label={t("sharing.pause.label")} value={s.sharingPaused} onChange={(on) => setS({ ...s, sharingPaused: on })} />
            <Hint>{t("privacy.peopleHint")}</Hint>
          </VStack>
        </Panel>
        <HStack>
          <Button type="submit" label={t("common.save")} variant="primary" isLoading={busy} />
        </HStack>
      </VStack>
    </form>
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

export function WebhooksView() {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
  const [hooks, reloadHooks] = useLoad(() => api<{ webhooks: Webhook[] }>("/v1/webhooks").then((r) => r.webhooks ?? []), []);
  const [dead, reloadDead] = useLoad(
    () => api<{ deadLetters: DeadLetter[] }>("/v1/webhooks/dead-letters?limit=20").then((r) => r.deadLetters ?? []),
    [],
  );
  const reload = async () => {
    await Promise.all([reloadHooks(), reloadDead()]);
  };
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, add] = useAction(async () => {
    await api("/v1/webhooks", { body: { url: url.trim(), events: ["*"], ...(secret ? { secret } : {}) } });
    notify.ok(t("toast.added"));
    setUrl("");
    setSecret("");
    await reload();
  });
  const remove = async (w: Webhook) => {
    if (!(await confirm({ title: t("webhooks.deleteConfirm"), description: w.url, action: t("common.delete") }))) return;
    try {
      await api(`/v1/webhooks/${encodeURIComponent(w.id)}`, { method: "DELETE" });
      notify.ok(t("toast.deleted"));
    } catch (e) {
      notify.fail(e);
    }
    await reload();
  };
  return (
    <Page title={t("webhooks.title")} description={t("webhooks.desc")}>
      <Panel title={t("webhooks.list")}>
        <Loaded state={hooks}>
          {(list) =>
            list.length ? (
              <Table
                data={list.map((w) => ({ ...w }))}
                idKey="id"
                columns={[
                  { key: "url", header: t("webhooks.url"), renderCell: (w) => <Text type="code" wordBreak="break-all">{w.url}</Text> },
                  { key: "events", header: t("webhooks.events"), renderCell: (w) => (w.events ?? []).join(", ") },
                  {
                    key: "active",
                    header: t("webhooks.active"),
                    renderCell: (w) => (w.active ? t("common.yes") : <Badge variant="warning" label={t("common.no")} />),
                  },
                  {
                    key: "actions",
                    header: "",
                    align: "end",
                    renderCell: (w) => <Button label={t("common.delete")} variant="destructive" size="sm" clickAction={() => remove(w)} />,
                  },
                ]}
              />
            ) : (
              <Empty text={t("webhooks.empty")} />
            )
          }
        </Loaded>
      </Panel>
      <Panel title={t("webhooks.add")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (/^https?:\/\//i.test(url.trim())) void add();
          }}
        >
          <HStack gap={2} wrap="wrap" vAlign="end">
            <TextInput label="URL" value={url} onChange={setUrl} placeholder="https://…" isRequired width={320} />
            <TextInput label={t("webhooks.secret")} value={secret} onChange={setSecret} width={240} />
            <Button type="submit" label={t("webhooks.addButton")} variant="primary" isLoading={busy} isDisabled={!/^https?:\/\//i.test(url.trim())} />
          </HStack>
        </form>
      </Panel>
      <Panel title={t("webhooks.deadLetters")}>
        <Loaded state={dead}>
          {(list) =>
            list.length ? (
              <Table
                data={list.map((x, i) => ({ ...x, key: x.id ?? String(i) }))}
                idKey="key"
                columns={[
                  { key: "eventType", header: t("events.type"), renderCell: (x) => <Text type="code">{x.eventType}</Text> },
                  { key: "error", header: t("webhooks.error"), renderCell: (x) => x.error ?? "" },
                  { key: "createdAt", header: t("events.when"), renderCell: (x) => <Timestamp value={x.createdAt} format="date_time" /> },
                ]}
              />
            ) : (
              <Empty text={t("webhooks.deadEmpty")} />
            )
          }
        </Loaded>
      </Panel>
    </Page>
  );
}
