/**
 * Webhooks: send my own presence events to another service. The list shows
 * each endpoint's events and places; adding one or changing its events and
 * places happens in a dialog, which also shows what a delivery looks like
 * (built by the same code the server sends with). Pause a hook from the list,
 * and see deliveries that failed for good.
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
import { DialogForm, Empty, FormDialog, Hint, Loaded, Page, Panel, Row, Rows, useConfirm, useLoad, useNotify } from "../ui";

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

/** Every place (null), or some places by name; an empty list is not yet a choice. */
type PlaceSelection = string[] | null;

/** List values: any string can be a place name, so places get a prefix and the "*" pickEvents knows cannot collide. */
const ALL_PLACES = "*";
const placeValue = (name: string) => `place:${name}`;

/** Hidden while there are no places to pick. */
function PlacePicker({ names, value, onChange }: { names: string[]; value: PlaceSelection; onChange: (places: PlaceSelection) => void }) {
  const { t } = useApp();
  const shown = [...new Set([...names, ...(value ?? [])])];
  if (shown.length === 0) return null;
  const listed = value === null ? [ALL_PLACES] : value.map(placeValue);
  const pick = (next: string[]) => {
    const picked = pickEvents(listed, next);
    onChange(picked.includes(ALL_PLACES) ? null : shown.filter((name) => picked.includes(placeValue(name))));
  };
  return (
    <VStack gap={1}>
      <CheckboxList label={t("webhooks.places")} value={listed} onChange={pick} hasDividers>
        <CheckboxListItem value={ALL_PLACES} label={t("webhooks.allPlaces")} description={t("webhooks.allPlacesDesc")} />
        {shown.map((name) => (
          <CheckboxListItem key={name} value={placeValue(name)} label={name} />
        ))}
      </CheckboxList>
      {value?.length === 0 ? <Hint>{t("webhooks.pickPlace")}</Hint> : null}
    </VStack>
  );
}

const pickedSome = (places: PlaceSelection): boolean => places === null || places.length > 0;

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

function HookRow({ hook, onEdit, onChanged }: { hook: Webhook; onEdit: () => void; onChanged: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
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
        changeAction={async (active) => {
          try {
            await api(`/v1/webhooks/${encodeURIComponent(hook.id)}`, { method: "PATCH", body: { active } });
            notify.ok(t("toast.saved"));
            await onChanged();
          } catch (e) {
            notify.fail(e);
          }
        }}
        size="sm"
      />
      <Button label={t("webhooks.edit")} size="sm" onClick={onEdit} />
      <Button label={t("common.delete")} variant="destructive" size="sm" clickAction={remove} />
    </Row>
  );
}

function AddHook({ placeNames, onClose, onAdded }: { placeNames: string[]; onClose: () => void; onAdded: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  const [places, setPlaces] = useState<PlaceSelection>(null);
  const add = async () => {
    await api("/v1/webhooks", {
      body: { url: url.trim(), events, ...(places ? { places } : {}), ...(secret ? { secret } : {}) },
    });
    notify.ok(t("toast.added"));
    await onAdded();
  };
  return (
    <DialogForm
      title={t("webhooks.add")}
      submitLabel={t("webhooks.addButton")}
      canSubmit={/^https?:\/\//i.test(url.trim()) && events.length > 0 && pickedSome(places)}
      onSubmit={add}
      onClose={onClose}
    >
      <TextInput label={t("webhooks.url")} value={url} onChange={setUrl} placeholder="https://…" isRequired />
      <TextInput label={t("webhooks.secret")} value={secret} onChange={setSecret} />
      <EventPicker value={events} onChange={setEvents} />
      <PlacePicker names={placeNames} value={places} onChange={setPlaces} />
      <ExampleDelivery events={events} signed={secret !== ""} />
    </DialogForm>
  );
}

function EditHook({ hook, placeNames, onClose, onSaved }: { hook: Webhook; placeNames: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const [events, setEvents] = useState<string[]>(hook.events ?? []);
  const [places, setPlaces] = useState<PlaceSelection>(hook.places ?? null);
  const save = async () => {
    const samePlaces = JSON.stringify(places) === JSON.stringify(hook.places ?? null);
    await api(`/v1/webhooks/${encodeURIComponent(hook.id)}`, { method: "PATCH", body: { events, ...(samePlaces ? {} : { places }) } });
    notify.ok(t("toast.saved"));
    await onSaved();
  };
  return (
    <DialogForm
      title={t("webhooks.editTitle")}
      subtitle={hook.url}
      submitLabel={t("common.save")}
      canSubmit={events.length > 0 && pickedSome(places)}
      onSubmit={save}
      onClose={onClose}
    >
      <EventPicker value={events} onChange={setEvents} />
      <PlacePicker names={placeNames} value={places} onChange={setPlaces} />
    </DialogForm>
  );
}

/** Which form the dialog holds, if any. */
type HookDialog = { kind: "add" } | { kind: "edit"; hook: Webhook } | null;

export function WebhooksView() {
  const { t } = useApp();
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
  const [dialog, setDialog] = useState<HookDialog>(null);
  const close = () => setDialog(null);
  return (
    <Page title={t("webhooks.title")} description={t("webhooks.desc")}>
      <Banner status="info" title={t("webhooks.introTitle")} description={t("webhooks.intro")} collapsible={false} />
      <Panel
        title={t("webhooks.list")}
        actions={<Button label={t("webhooks.addOpen")} variant="primary" onClick={() => setDialog({ kind: "add" })} />}
      >
        <Loaded state={hooks}>
          {(list) =>
            list.length ? (
              <Rows items={list} keyOf={(w) => w.id}>
                {(w) => <HookRow hook={w} onEdit={() => setDialog({ kind: "edit", hook: w })} onChanged={reload} />}
              </Rows>
            ) : (
              <Empty text={t("webhooks.empty")} />
            )
          }
        </Loaded>
      </Panel>
      <FormDialog isOpen={dialog !== null} onClose={close}>
        {dialog?.kind === "add" ? (
          <AddHook placeNames={placeNames} onClose={close} onAdded={reload} />
        ) : dialog?.kind === "edit" ? (
          <EditHook hook={dialog.hook} placeNames={placeNames} onClose={close} onSaved={reload} />
        ) : null}
      </FormDialog>
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
