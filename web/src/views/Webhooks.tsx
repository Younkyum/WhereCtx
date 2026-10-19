/**
 * Webhooks: send my own presence events to another service. Choose which
 * events each endpoint gets, give it a signing secret or an auth header, see
 * what a delivery looks like (built by the same code the server sends with),
 * change a hook or pause it, and see deliveries that failed for good. Adding
 * and editing happen in a dialog; the page keeps the explanation and the list.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
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
import { oneOf, type DeadLetter, type Webhook } from "../model";
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

function EventSummary({ events }: { events: string[] }) {
  const { t } = useApp();
  if (events.includes("*")) return <Badge variant="info" label={t("webhooks.all")} />;
  return (
    <HStack gap={1} wrap="wrap">
      {events.map((e) => (
        <Badge key={e} variant="neutral" label={oneOf(PRESENCE_EVENT_TYPES, e) ? t(`webhooks.event.${e}`) : e} />
      ))}
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
          autoComplete="off"
          status={problem === "value" ? { type: "error", message: t("webhooks.authErr.value") } : undefined}
        />
      </HStack>
      <Hint>{t("webhooks.authStored")}</Hint>
    </VStack>
  );
}

function AuthHeaderSection({ children }: { children: ReactNode }) {
  const { t } = useApp();
  return (
    <VStack gap={2}>
      <Text weight="semibold">{t("webhooks.authTitle")}</Text>
      <Hint>{t("webhooks.authHelp")}</Hint>
      {children}
    </VStack>
  );
}

function FormDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={640}>
      <VStack gap={4}>
        <DialogHeader title={title} onOpenChange={(open) => (open ? undefined : onClose())} />
        {children}
      </VStack>
    </Dialog>
  );
}

function AddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  const [auth, setAuth] = useState<AuthDraft>(EMPTY_AUTH);
  const { header, problem } = readAuthDraft(auth);
  const valid = /^https?:\/\//i.test(url.trim()) && events.length > 0 && problem === null;
  const [busy, add] = useAction(async () => {
    await api("/v1/webhooks", {
      body: { url: url.trim(), events, ...(secret ? { secret } : {}), ...(header ? { authHeader: header } : {}) },
    });
    notify.ok(t("toast.added"));
    onClose();
    await onAdded();
  });
  return (
    <FormDialog title={t("webhooks.add")} onClose={onClose}>
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
          <AuthHeaderSection>
            <AuthHeaderFields draft={auth} onChange={setAuth} />
          </AuthHeaderSection>
          <ExampleDelivery events={events} signed={secret !== ""} authHeader={header ? viewAuthHeader(header) : undefined} />
          <HStack gap={2}>
            <Button type="submit" label={t("webhooks.addButton")} variant="primary" isLoading={busy} isDisabled={!valid} />
            <Button label={t("common.cancel")} onClick={onClose} />
          </HStack>
        </VStack>
      </form>
    </FormDialog>
  );
}

/** What saving the edit dialog does to the auth header: leave it, send a new one, or stop sending one. */
type AuthEdit = "keep" | "replace" | "remove";

function EditDialog({ hook, onClose, onSaved }: { hook: Webhook; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const [events, setEvents] = useState<string[]>(hook.events ?? []);
  const [active, setActive] = useState(hook.active);
  const [authEdit, setAuthEdit] = useState<AuthEdit>("keep");
  const [auth, setAuth] = useState<AuthDraft>({ ...EMPTY_AUTH, name: hook.authHeader?.name ?? DEFAULT_AUTH_HEADER_NAME });
  const { header, problem } = readAuthDraft(auth);
  const replacing = authEdit === "replace";
  const valid = events.length > 0 && (!replacing || (header !== null && problem === null));
  const [saving, save] = useAction(async () => {
    const body: { events?: string[]; active?: boolean; authHeader?: WebhookAuthHeader | null } = {};
    if (JSON.stringify(events) !== JSON.stringify(hook.events ?? [])) body.events = events;
    if (active !== hook.active) body.active = active;
    if (replacing && header) body.authHeader = header;
    if (authEdit === "remove") body.authHeader = null;
    if (Object.keys(body).length > 0) {
      await api(`/v1/webhooks/${encodeURIComponent(hook.id)}`, { method: "PATCH", body });
      notify.ok(t("toast.saved"));
    }
    onClose();
    await onSaved();
  });
  return (
    <FormDialog title={t("webhooks.editTitle")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save();
        }}
      >
        <VStack gap={4}>
          <Text type="code" wordBreak="break-all">
            {hook.url}
          </Text>
          <Switch label={t("webhooks.active")} value={active} onChange={setActive} size="sm" />
          <EventPicker value={events} onChange={setEvents} />
          <AuthHeaderSection>
            {replacing ? (
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
            ) : hook.authHeader ? (
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text>{t("webhooks.authCurrent", { name: hook.authHeader.name, hint: hook.authHeader.hint })}</Text>
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
          <HStack gap={2}>
            <Button type="submit" label={t("common.save")} variant="primary" isLoading={saving} isDisabled={!valid} />
            <Button label={t("common.cancel")} onClick={onClose} />
          </HStack>
        </VStack>
      </form>
    </FormDialog>
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
      subtitle={
        <HStack gap={1} wrap="wrap">
          {hook.active ? null : <Badge variant="warning" label={t("webhooks.paused")} />}
          <EventSummary events={hook.events ?? []} />
          {hook.authHeader ? <Badge variant="neutral" label={t("webhooks.authBadge", { name: hook.authHeader.name, hint: hook.authHeader.hint })} /> : null}
        </HStack>
      }
    >
      <Button label={t("webhooks.edit")} size="sm" onClick={onEdit} />
      <Button label={t("common.delete")} variant="destructive" size="sm" clickAction={remove} />
    </Row>
  );
}

export function WebhooksView() {
  const { t } = useApp();
  const [hooks, reloadHooks] = useLoad(() => api<{ webhooks: Webhook[] }>("/v1/webhooks").then((r) => r.webhooks ?? []), []);
  const [dead, reloadDead] = useLoad(
    () => api<{ deadLetters: DeadLetter[] }>("/v1/webhooks/dead-letters?limit=20").then((r) => r.deadLetters ?? []),
    [],
  );
  const reload = async () => {
    await Promise.all([reloadHooks(), reloadDead()]);
  };
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "edit"; hook: Webhook } | null>(null);
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
      {dialog?.kind === "add" ? <AddDialog onClose={close} onAdded={reload} /> : null}
      {dialog?.kind === "edit" ? <EditDialog key={dialog.hook.id} hook={dialog.hook} onClose={close} onSaved={reload} /> : null}
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
