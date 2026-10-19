/**
 * Webhooks: send my own presence events to another service. Choose which
 * events each endpoint gets and for which places, see what a delivery looks
 * like (built by the same code the server sends with), change a hook's
 * events or pause it, and see deliveries that failed for good.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Switch } from "@astryxdesign/core/Switch";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useState } from "react";
import { PRESENCE_EVENT_TYPES, type PresenceEventType } from "../../../src/types";
import { exampleDelivery } from "../../../src/webhooks/payload";
import { api } from "../api";
import { useApp } from "../context";
import { pickEvents } from "../lib";
import { oneOf, type DeadLetter, type Place, type Webhook } from "../model";
import { Empty, Hint, Loaded, Page, Panel, Row, Rows, useAction, useConfirm, useLoad, useNotify } from "../ui";

export const SIGNATURE_DOCS = "https://github.com/Younkyum/WhereCtx/blob/main/docs/api.md#delivery-signature";
/** What a new endpoint gets unless the person picks otherwise: arrivals and departures. */
export const DEFAULT_EVENTS: PresenceEventType[] = ["presence.entered_place", "presence.left_place"];

function EventPicker({ value, onChange }: { value: string[]; onChange: (events: string[]) => void }) {
  const { t } = useApp();
  return (
    <CheckboxList label={t("webhooks.pick")} value={value} onChange={(next) => onChange(pickEvents(value, next))} hasDividers>
      <CheckboxListItem value="*" label={t("webhooks.all")} description={t("webhooks.allDesc")} />
      {PRESENCE_EVENT_TYPES.map((type) => (
        <CheckboxListItem
          key={type}
          value={type}
          label={t(`webhooks.event.${type}`)}
          description={
            <>
              {t(`webhooks.eventDesc.${type}`)} <Text type="code">{type}</Text>
            </>
          }
        />
      ))}
    </CheckboxList>
  );
}

/**
 * Every place, or some of them by name; ["*"] means every place, as the event
 * picker's "*" does. Hidden while there are no places to pick.
 */
function PlacePicker({ names, value, onChange }: { names: string[]; value: string[]; onChange: (places: string[]) => void }) {
  const { t } = useApp();
  const shown = [...new Set([...names, ...value.filter((v) => v !== "*")])];
  if (shown.length === 0) return null;
  return (
    <CheckboxList label={t("webhooks.places")} value={value} onChange={(next) => onChange(pickEvents(value, next))} hasDividers>
      <CheckboxListItem value="*" label={t("webhooks.allPlaces")} description={t("webhooks.allPlacesDesc")} />
      {shown.map((name) => (
        <CheckboxListItem key={name} value={name} label={name} />
      ))}
    </CheckboxList>
  );
}

/** The REST spelling of a picked place selection: null for every place. */
const placesBody = (picked: string[]): string[] | null => (picked.includes("*") || picked.length === 0 ? null : picked);

function EventSummary({ events, places }: { events: string[]; places?: string[] }) {
  const { t } = useApp();
  return (
    <HStack gap={1} wrap="wrap">
      {events.includes("*") ? (
        <Badge variant="info" label={t("webhooks.all")} />
      ) : (
        events.map((e) => <Badge key={e} variant="neutral" label={oneOf(PRESENCE_EVENT_TYPES, e) ? t(`webhooks.event.${e}`) : e} />)
      )}
      {places?.map((name) => <Badge key={`place:${name}`} variant="info" label={name} />)}
    </HStack>
  );
}

function ExampleDelivery({ events, signed }: { events: string[]; signed: boolean }) {
  const { t } = useApp();
  const type = events.find((e): e is PresenceEventType => oneOf(PRESENCE_EVENT_TYPES, e)) ?? "presence.entered_place";
  const { headers, body } = exampleDelivery(type, signed);
  const text =
    `POST <your URL>\n` +
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n") +
    `\n\n${JSON.stringify(body, null, 2)}`;
  return (
    <VStack gap={2}>
      <CodeBlock code={text} title={t("webhooks.example")} language="plaintext" isWrapped width="100%" hasLanguageLabel={false} />
      <Hint>
        {t(signed ? "webhooks.verifySigned" : "webhooks.verifyUnsigned")}{" "}
        <Link href={SIGNATURE_DOCS} isExternalLink>
          {t("webhooks.verifyLink")}
        </Link>
      </Hint>
    </VStack>
  );
}

function HookRow({ hook, placeNames, onChanged }: { hook: Webhook; placeNames: string[]; onChanged: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ events: string[]; places: string[] } | null>(null);
  const patch = async (body: { events?: string[]; places?: string[] | null; active?: boolean }) => {
    await api(`/v1/webhooks/${encodeURIComponent(hook.id)}`, { method: "PATCH", body });
    notify.ok(t("toast.saved"));
    await onChanged();
  };
  const [saving, save] = useAction(async () => {
    if (!editing?.events.length) return;
    const places = placesBody(editing.places);
    const samePlaces = JSON.stringify(places) === JSON.stringify(hook.places ?? null);
    await patch({ events: editing.events, ...(samePlaces ? {} : { places }) });
    setEditing(null);
  });
  const remove = async () => {
    if (!(await confirm({ title: t("webhooks.deleteConfirm"), description: hook.url, action: t("common.delete") }))) return;
    try {
      await api(`/v1/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
      notify.ok(t("toast.deleted"));
    } catch (e) {
      notify.fail(e);
    }
    await onChanged();
  };
  return (
    <VStack gap={2}>
      <Row
        title={
          <Text type="code" wordBreak="break-all">
            {hook.url}
          </Text>
        }
        subtitle={<EventSummary events={hook.events ?? []} places={hook.places} />}
      >
        <Switch
          label={t("webhooks.active")}
          value={hook.active}
          changeAction={async (on) => {
            try {
              await patch({ active: on });
            } catch (e) {
              notify.fail(e);
            }
          }}
          size="sm"
        />
        {editing ? null : (
          <Button
            label={t("webhooks.editEvents")}
            size="sm"
            onClick={() => setEditing({ events: hook.events ?? [], places: hook.places ?? ["*"] })}
          />
        )}
        <Button label={t("common.delete")} variant="destructive" size="sm" clickAction={remove} />
      </Row>
      {editing ? (
        <VStack gap={3}>
          <EventPicker value={editing.events} onChange={(events) => setEditing({ ...editing, events })} />
          <PlacePicker names={placeNames} value={editing.places} onChange={(places) => setEditing({ ...editing, places })} />
          <HStack gap={2}>
            <Button label={t("common.save")} variant="primary" isLoading={saving} isDisabled={!editing.events.length} onClick={() => void save()} />
            <Button label={t("common.cancel")} onClick={() => setEditing(null)} />
          </HStack>
        </VStack>
      ) : null}
    </VStack>
  );
}

export function WebhooksView() {
  const { t } = useApp();
  const notify = useNotify();
  const [hooks, reloadHooks] = useLoad(() => api<{ webhooks: Webhook[] }>("/v1/webhooks").then((r) => r.webhooks ?? []), []);
  const [dead, reloadDead] = useLoad(
    () => api<{ deadLetters: DeadLetter[] }>("/v1/webhooks/dead-letters?limit=20").then((r) => r.deadLetters ?? []),
    [],
  );
  const [places] = useLoad(() => api<{ places: Place[] }>("/v1/places").then((r) => r.places ?? []), []);
  const placeNames = places.kind === "ready" ? places.data.map((p) => p.name) : [];
  const reload = async () => {
    await Promise.all([reloadHooks(), reloadDead()]);
  };
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  const [placesPicked, setPlacesPicked] = useState<string[]>(["*"]);
  const valid = /^https?:\/\//i.test(url.trim()) && events.length > 0;
  const [busy, add] = useAction(async () => {
    const picked = placesBody(placesPicked);
    await api("/v1/webhooks", { body: { url: url.trim(), events, ...(picked ? { places: picked } : {}), ...(secret ? { secret } : {}) } });
    notify.ok(t("toast.added"));
    setUrl("");
    setSecret("");
    setEvents(DEFAULT_EVENTS);
    setPlacesPicked(["*"]);
    await reload();
  });
  return (
    <Page title={t("webhooks.title")} description={t("webhooks.desc")}>
      <Banner status="info" title={t("webhooks.introTitle")} description={t("webhooks.intro")} collapsible={false} />
      <Panel title={t("webhooks.list")}>
        <Loaded state={hooks}>
          {(list) =>
            list.length ? (
              <Rows items={list} keyOf={(w) => w.id}>
                {(w) => <HookRow hook={w} placeNames={placeNames} onChanged={reload} />}
              </Rows>
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
            if (valid) void add();
          }}
        >
          <VStack gap={4}>
            <HStack gap={2} wrap="wrap" vAlign="end">
              <TextInput label="URL" value={url} onChange={setUrl} placeholder="https://…" isRequired width={320} />
              <TextInput label={t("webhooks.secret")} value={secret} onChange={setSecret} width={240} />
            </HStack>
            <EventPicker value={events} onChange={setEvents} />
            <PlacePicker names={placeNames} value={placesPicked} onChange={setPlacesPicked} />
            <ExampleDelivery events={events} signed={secret !== ""} />
            <HStack>
              <Button type="submit" label={t("webhooks.addButton")} variant="primary" isLoading={busy} isDisabled={!valid} />
            </HStack>
          </VStack>
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
