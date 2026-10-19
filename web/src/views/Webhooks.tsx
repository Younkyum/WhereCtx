/**
 * Webhooks: send my own presence events to another service. The list shows
 * each endpoint's events, places and auth header; adding one or changing its
 * events, places and auth header happens in a dialog, which also shows what a
 * delivery looks like (built by the same code the server sends with). Pause a
 * hook from the list, and see deliveries that failed for good.
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
import { useState, type ReactNode } from "react";
import { PRESENCE_EVENT_TYPES, type PresenceEventType } from "../../../src/types";
import {
  authHeaderNeedsHttps,
  authHeaderProblem,
  DEFAULT_AUTH_HEADER_NAME,
  viewAuthHeader,
  type AuthHeaderProblem,
  type WebhookAuthHeader,
  type WebhookAuthHeaderView,
} from "../../../src/webhooks/authHeader";
import { exampleDelivery } from "../../../src/webhooks/payload";
import { api } from "../api";
import { useApp } from "../context";
import { pickEvents } from "../lib";
import { oneOf, type DeadLetter, type Place, type Webhook, type WebhookCapabilities } from "../model";
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

function ExampleDelivery({ events, signed, authHeader }: { events: string[]; signed: boolean; authHeader?: WebhookAuthHeaderView }) {
  const { t } = useApp();
  const type = events.find((e): e is PresenceEventType => oneOf(PRESENCE_EVENT_TYPES, e)) ?? "presence.entered_place";
  const { headers, body } = exampleDelivery(type, { signed, authHeader });
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

interface AuthDraft {
  name: string;
  value: string;
}

const EMPTY_AUTH: AuthDraft = { name: DEFAULT_AUTH_HEADER_NAME, value: "" };

/** A draft as the header to send: null when no value is typed, or why it cannot be sent. */
function readAuthDraft(draft: AuthDraft): { header: WebhookAuthHeader | null; problem: AuthHeaderProblem | null } {
  const name = draft.name.trim();
  const value = draft.value.trim();
  if (value === "") return { header: null, problem: null };
  const problem = authHeaderProblem(name, value);
  return problem ? { header: null, problem } : { header: { name, value }, problem: null };
}

function AuthHeaderFields({ draft, onChange }: { draft: AuthDraft; onChange: (draft: AuthDraft) => void }) {
  const { t } = useApp();
  const { problem } = readAuthDraft(draft);
  const nameProblem = problem === "name" || problem === "notAllowed" ? problem : null;
  return (
    <VStack gap={2}>
      <HStack gap={2} wrap="wrap" vAlign="start">
        <TextInput
          label={t("webhooks.authName")}
          value={draft.name}
          onChange={(name) => onChange({ ...draft, name })}
          width={200}
          autoComplete="off"
          status={nameProblem ? { type: "error", message: t(`webhooks.authErr.${nameProblem}`) } : undefined}
        />
        <TextInput
          label={t("webhooks.authValue")}
          type="password"
          value={draft.value}
          onChange={(value) => onChange({ ...draft, value })}
          placeholder={t("webhooks.authValuePlaceholder")}
          width={280}
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          status={problem === "value" ? { type: "error", message: t("webhooks.authErr.value") } : undefined}
        />
      </HStack>
      <Hint>{t("webhooks.authStored")}</Hint>
    </VStack>
  );
}

/** The auth header part of a dialog: its explanation, then the fields, or why the server cannot take one. */
function AuthHeaderSection({ capabilities, children }: { capabilities: WebhookCapabilities; children: ReactNode }) {
  const { t } = useApp();
  return (
    <VStack gap={2}>
      <Text weight="semibold">{t("webhooks.authTitle")}</Text>
      <Hint>{t("webhooks.authHelp")}</Hint>
      {capabilities.authHeader ? children : <Banner status="warning" title={t("webhooks.authNoKeyTitle")} description={t("webhooks.authNoKey")} collapsible={false} />}
    </VStack>
  );
}

/** Why `url` cannot carry an auth header on this server, as an error message, or undefined. */
function useHttpsProblem(url: string, capabilities: WebhookCapabilities): string | undefined {
  const { t } = useApp();
  return authHeaderNeedsHttps(url, !capabilities.authHeaderRequiresHttps) ? t("webhooks.authNeedsHttps") : undefined;
}

/** What saving the edit dialog does to the auth header: leave it, send a new one, or stop sending one. */
type AuthEdit = "keep" | "replace" | "remove";

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
      subtitle={
        <HStack gap={1} wrap="wrap">
          {hook.credentialsUnreadable ? <Badge variant="error" label={t("webhooks.unreadable")} /> : null}
          <EventSummary events={hook.events ?? []} places={hook.places} />
          {hook.authHeader ? <Badge variant="neutral" label={t("webhooks.authBadge", { name: hook.authHeader.name, hint: hook.authHeader.hint })} /> : null}
        </HStack>
      }
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

function AddHook({
  placeNames,
  capabilities,
  onClose,
  onAdded,
}: {
  placeNames: string[];
  capabilities: WebhookCapabilities;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const { t } = useApp();
  const notify = useNotify();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  const [places, setPlaces] = useState<PlaceSelection>(null);
  const [auth, setAuth] = useState<AuthDraft>(EMPTY_AUTH);
  const { header, problem } = readAuthDraft(auth);
  const httpsProblem = useHttpsProblem(url.trim(), capabilities);
  const blockedByHttps = header !== null && httpsProblem !== undefined;
  const add = async () => {
    await api("/v1/webhooks", {
      body: {
        url: url.trim(),
        events,
        ...(places ? { places } : {}),
        ...(secret ? { secret } : {}),
        ...(header ? { authHeader: header } : {}),
      },
    });
    notify.ok(t("toast.added"));
    await onAdded();
  };
  return (
    <DialogForm
      title={t("webhooks.add")}
      submitLabel={t("webhooks.addButton")}
      canSubmit={/^https?:\/\//i.test(url.trim()) && events.length > 0 && pickedSome(places) && problem === null && !blockedByHttps}
      onSubmit={add}
      onClose={onClose}
    >
      <TextInput label={t("webhooks.url")} value={url} onChange={setUrl} placeholder="https://…" isRequired />
      <TextInput label={t("webhooks.secret")} value={secret} onChange={setSecret} />
      <EventPicker value={events} onChange={setEvents} />
      <PlacePicker names={placeNames} value={places} onChange={setPlaces} />
      <AuthHeaderSection capabilities={capabilities}>
        <AuthHeaderFields draft={auth} onChange={setAuth} />
        {blockedByHttps ? <Banner status="error" title={t("webhooks.authNeedsHttpsTitle")} description={httpsProblem} collapsible={false} /> : null}
      </AuthHeaderSection>
      <ExampleDelivery events={events} signed={secret !== ""} authHeader={header ? viewAuthHeader(header) : undefined} />
    </DialogForm>
  );
}

function EditHook({
  hook,
  placeNames,
  capabilities,
  onClose,
  onSaved,
}: {
  hook: Webhook;
  placeNames: string[];
  capabilities: WebhookCapabilities;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useApp();
  const notify = useNotify();
  const [events, setEvents] = useState<string[]>(hook.events ?? []);
  const [places, setPlaces] = useState<PlaceSelection>(hook.places ?? null);
  const [authEdit, setAuthEdit] = useState<AuthEdit>("keep");
  const [auth, setAuth] = useState<AuthDraft>({ ...EMPTY_AUTH, name: hook.authHeader?.name ?? DEFAULT_AUTH_HEADER_NAME });
  const { header, problem } = readAuthDraft(auth);
  const replacing = authEdit === "replace";
  const httpsProblem = useHttpsProblem(hook.url, capabilities);
  const save = async () => {
    const body: { events?: string[]; places?: PlaceSelection; authHeader?: WebhookAuthHeader | null } = {};
    if (JSON.stringify(events) !== JSON.stringify(hook.events ?? [])) body.events = events;
    if (JSON.stringify(places) !== JSON.stringify(hook.places ?? null)) body.places = places;
    if (replacing && header) body.authHeader = header;
    if (authEdit === "remove") body.authHeader = null;
    if (Object.keys(body).length === 0) return;
    await api(`/v1/webhooks/${encodeURIComponent(hook.id)}`, { method: "PATCH", body });
    notify.ok(t("toast.saved"));
    await onSaved();
  };
  return (
    <DialogForm
      title={t("webhooks.editTitle")}
      subtitle={hook.url}
      submitLabel={t("common.save")}
      canSubmit={events.length > 0 && pickedSome(places) && (!replacing || (header !== null && problem === null))}
      onSubmit={save}
      onClose={onClose}
    >
      <EventPicker value={events} onChange={setEvents} />
      <PlacePicker names={placeNames} value={places} onChange={setPlaces} />
      {hook.credentialsUnreadable ? <Banner status="error" title={t("webhooks.unreadable")} description={t("webhooks.unreadableHelp")} collapsible={false} /> : null}
      <AuthHeaderSection capabilities={capabilities}>
        {replacing && httpsProblem ? (
          <Text>{httpsProblem}</Text>
        ) : replacing ? (
          <VStack gap={2}>
            <AuthHeaderFields draft={auth} onChange={setAuth} />
            <HStack>
              <Button label={t("common.cancel")} size="sm" onClick={() => setAuthEdit("keep")} />
            </HStack>
          </VStack>
        ) : authEdit === "remove" ? (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text>{t("webhooks.authRemoving")}</Text>
            <Button label={t("webhooks.authKeep")} size="sm" onClick={() => setAuthEdit("keep")} />
          </HStack>
        ) : hook.authHeader || hook.credentialsUnreadable ? (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text>
              {hook.authHeader
                ? t("webhooks.authCurrent", { name: hook.authHeader.name, hint: hook.authHeader.hint })
                : t("webhooks.unreadable")}
            </Text>
            <Button label={t("webhooks.authReplace")} size="sm" onClick={() => setAuthEdit("replace")} />
            <Button label={t("webhooks.authRemove")} variant="destructive" size="sm" onClick={() => setAuthEdit("remove")} />
          </HStack>
        ) : (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text>{t("webhooks.authNone")}</Text>
            <Button label={t("webhooks.authAdd")} size="sm" onClick={() => setAuthEdit("replace")} />
          </HStack>
        )}
      </AuthHeaderSection>
    </DialogForm>
  );
}

/** Which form the dialog holds, if any. */
type HookDialog = { kind: "add" } | { kind: "edit"; hook: Webhook } | null;

export function WebhooksView() {
  const { t } = useApp();
  const [hooks, reloadHooks] = useLoad(
    () =>
      api<{ webhooks: Webhook[]; capabilities?: WebhookCapabilities }>("/v1/webhooks").then((r) => ({
        list: r.webhooks ?? [],
        capabilities: r.capabilities ?? { authHeader: false, authHeaderRequiresHttps: true },
      })),
    [],
  );
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
          {({ list }) =>
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
      <FormDialog isOpen={dialog !== null && hooks.kind === "ready"} onClose={close}>
        {hooks.kind !== "ready" ? null : dialog?.kind === "add" ? (
          <AddHook placeNames={placeNames} capabilities={hooks.data.capabilities} onClose={close} onAdded={reload} />
        ) : dialog?.kind === "edit" ? (
          <EditHook hook={dialog.hook} placeNames={placeNames} capabilities={hooks.data.capabilities} onClose={close} onSaved={reload} />
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
