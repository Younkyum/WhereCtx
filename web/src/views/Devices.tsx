/**
 * Connecting phones (OwnTracks by QR code, the iOS Shortcut by URL and
 * header) and agents (a token plus its MCP config). Secrets appear once, right
 * after creation; the lists show tokens without them.
 */

import { Badge, type BadgeProps } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api } from "../api";
import { useApp } from "../context";
import { qrFromSvg } from "../lib";
import type { ApiToken, DeviceSummary, IngestEntry, IngestOutcome, Pairing } from "../model";
import { Empty, Hint, Loaded, Page, Panel, Row, Rows, Secret, download, useAction, useConfirm, useFormat, useLoad, useNotify, usePaged } from "../ui";

function useTokens(keep: (k: ApiToken) => boolean) {
  return useLoad(() => api<{ tokens: ApiToken[] }>("/v1/tokens").then((r) => (r.tokens ?? []).filter(keep)), []);
}

/** Revoke a token after a confirmation, then refresh the list it came from. */
function useRevoke(onChanged: () => Promise<void>) {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
  return async (k: { id: string; name: string }) => {
    if (!(await confirm({ title: t("tokens.revokeConfirm", { name: k.name }), action: t("common.revoke") }))) return;
    try {
      await api(`/v1/tokens/${encodeURIComponent(k.id)}`, { method: "DELETE" });
      notify.ok(t("toast.revoked"));
    } catch (e) {
      notify.fail(e);
    }
    await onChanged();
  };
}

function TokenTable({ tokens, emptyText, onChanged }: { tokens: ApiToken[]; emptyText: string; onChanged: () => Promise<void> }) {
  const { t } = useApp();
  const revoke = useRevoke(onChanged);
  if (!tokens.length) return <Empty text={emptyText} />;
  return (
    <Table
      data={tokens.map((k) => ({ ...k }))}
      idKey="id"
      columns={[
        { key: "name", header: t("tokens.name") },
        { key: "role", header: t("tokens.role"), renderCell: (k) => t(`tokenRole.${k.role}`) },
        {
          key: "lastUsedAt",
          header: t("tokens.lastUsed"),
          renderCell: (k) => (k.lastUsedAt ? <Timestamp value={k.lastUsedAt} format="date_time" /> : t("tokens.never")),
        },
        {
          key: "actions",
          header: "",
          align: "end",
          renderCell: (k) => <Button label={t("common.revoke")} variant="destructive" size="sm" clickAction={() => revoke(k)} />,
        },
      ]}
    />
  );
}

type PairResult = { kind: "paired"; name: string; pairing: Pairing } | { kind: "baseUrl"; message: string };

export const INGEST_BADGE: Record<IngestOutcome, BadgeProps["variant"]> = {
  accepted: "success",
  rejected: "error",
  ignored: "neutral",
};

function DeviceList({ devices, onChanged }: { devices: DeviceSummary[]; onChanged: () => Promise<void> }) {
  const { t } = useApp();
  const format = useFormat();
  const revoke = useRevoke(onChanged);
  if (!devices.length) return <Empty text={t("devices.empty")} />;
  return (
    <Rows items={devices} keyOf={(d) => d.id}>
      {(d) => (
        <Row
          title={
            <HStack gap={2} wrap="wrap" vAlign="center">
              <Text weight="semibold">{d.name}</Text>
              {d.lastOutcome ? <Badge variant={INGEST_BADGE[d.lastOutcome]} label={t(`ingest.outcome.${d.lastOutcome}`)} /> : null}
            </HStack>
          }
          subtitle={
            <VStack gap={0.5}>
              <Text type="supporting">
                {d.lastReceivedAt ? t("devices.lastReceived", { when: format.time(d.lastReceivedAt) }) : t("devices.neverReceived")}
              </Text>
              <Text type="supporting">{t("devices.counts", { accepted: d.accepted24h, rejected: d.rejected24h })}</Text>
            </VStack>
          }
        >
          <Button label={t("common.revoke")} variant="destructive" size="sm" clickAction={() => revoke(d)} />
        </Row>
      )}
    </Rows>
  );
}

function RecentUploads() {
  const { t } = useApp();
  const format = useFormat();
  const log = usePaged<IngestEntry>("/v1/activity/ingest?limit=20");
  return (
    <VStack gap={3}>
      <Loaded state={log.state}>
        {(entries) =>
          entries.length ? (
            <Rows items={entries} keyOf={(e) => e.id}>
              {(e) => (
                <Row
                  title={
                    <HStack gap={2} wrap="wrap" vAlign="center">
                      <Text weight="semibold">{e.token?.name ?? t("devices.fromDashboard")}</Text>
                      <Badge variant={INGEST_BADGE[e.outcome] ?? "neutral"} label={t(`ingest.outcome.${e.outcome}`)} />
                    </HStack>
                  }
                  subtitle={[t(`ingest.route.${e.source}`), format.time(e.receivedAt), e.reason].filter(Boolean).join(" · ")}
                />
              )}
            </Rows>
          ) : (
            <Empty text={t("devices.uploadsEmpty")} />
          )
        }
      </Loaded>
      {log.hasMore ? (
        <HStack>
          <Button label={t("activity.more")} isLoading={log.loadingMore} onClick={() => void log.more()} />
        </HStack>
      ) : null}
      <Hint>{t("devices.uploadsNote")}</Hint>
    </VStack>
  );
}

export function DevicesView() {
  const { t } = useApp();
  const [devices, reloadDevices] = useLoad(() => api<{ devices: DeviceSummary[] }>("/v1/devices").then((r) => r.devices ?? []), []);
  const [version, setVersion] = useState(0);
  const reload = async () => {
    setVersion((v) => v + 1);
    await reloadDevices();
  };
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Pairing["kind"]>("owntracks");
  const [result, setResult] = useState<PairResult | null>(null);
  const [busy, pair] = useAction(async () => {
    setResult(null);
    try {
      const pairing = await api<Pairing>("/v1/devices/pair", { body: { name: name.trim(), kind } });
      setResult({ kind: "paired", name: name.trim(), pairing });
      setName("");
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "base_url_unusable") setResult({ kind: "baseUrl", message: e.message });
      else throw e;
    }
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void pair();
  };
  return (
    <Page title={t("devices.title")} description={t("devices.desc")}>
      <Panel title={t("devices.connect")}>
        <VStack gap={4}>
          <form onSubmit={submit}>
            <VStack gap={4}>
              <TextInput
                label={t("devices.name")}
                placeholder={t("devices.namePlaceholder")}
                value={name}
                onChange={setName}
                isRequired
                width="100%"
              />
              <RadioList label={t("devices.kind")} value={kind} onChange={(v) => setKind(v === "shortcut" ? "shortcut" : "owntracks")}>
                <RadioListItem value="owntracks" label="OwnTracks" description={t("devices.owntracksDesc")} />
                <RadioListItem value="shortcut" label={t("devices.shortcut")} description={t("devices.shortcutDesc")} />
              </RadioList>
              <HStack>
                <Button type="submit" label={t("devices.create")} variant="primary" isLoading={busy} isDisabled={!name.trim()} />
              </HStack>
            </VStack>
          </form>
          {result?.kind === "baseUrl" ? (
            <Banner
              status="warning"
              title={t("devices.baseUrl.title")}
              description={t("devices.baseUrl.desc")}
              collapsible={false}
            >
              <Code>{result.message}</Code>
            </Banner>
          ) : null}
          {result?.kind === "paired" ? <PairingResult name={result.name} pairing={result.pairing} /> : null}
        </VStack>
      </Panel>
      <Panel title={t("devices.list")} actions={<Button label={t("devices.refresh")} size="sm" onClick={() => void reload()} />}>
        <Loaded state={devices}>{(list) => <DeviceList devices={list} onChanged={reload} />}</Loaded>
      </Panel>
      <Panel title={t("devices.uploads")}>
        <RecentUploads key={version} />
      </Panel>
    </Page>
  );
}

/** Numbered setup steps; long instructions wrap instead of truncating. */
function Steps({ steps }: { steps: { text: string; extra?: ReactNode }[] }) {
  return (
    <VStack as="ol" gap={3}>
      {steps.map((step, i) => (
        <HStack as="li" key={i} gap={2} vAlign="start">
          <Text weight="semibold" hasTabularNumbers>
            {i + 1}.
          </Text>
          <StackItem size="fill">
            <VStack gap={2}>
              <Text>{step.text}</Text>
              {step.extra}
            </VStack>
          </StackItem>
        </HStack>
      ))}
    </VStack>
  );
}

function PairingResult({ name, pairing }: { name: string; pairing: Pairing }) {
  const { t } = useApp();
  if (pairing.kind === "shortcut") {
    return (
      <VStack gap={3}>
        <Steps
          steps={[
            { text: t("devices.sc.step1") },
            { text: t("devices.sc.step2"), extra: <Secret label={t("devices.sc.url")} value={pairing.url} /> },
            { text: t("devices.sc.step3"), extra: <Secret label={t("devices.sc.header")} value={pairing.headers.Authorization} /> },
            { text: t("devices.sc.step4") },
            { text: t("devices.sc.step5") },
          ]}
        />
        <Hint>{t("devices.secretOnce")}</Hint>
      </VStack>
    );
  }
  const filename = (name.replace(/[^A-Za-z0-9_-]+/g, "-") || "wherectx") + ".otrc";
  return (
    <HStack gap={6} wrap="wrap" vAlign="start">
      <QrCode svg={pairing.qrSvg} label={t("devices.qrAlt")} />
      <StackItem size="fill">
        <VStack gap={3}>
          <Steps steps={[{ text: t("devices.ot.step1") }, { text: t("devices.ot.step2") }, { text: t("devices.ot.step3") }]} />
          <Banner status="info" title={t("devices.ot.iosTitle")} description={t("devices.ot.iosDesc")} collapsible={false} />
          <HStack gap={2} wrap="wrap">
            <Button label={t("devices.ot.open")} variant="primary" href={pairing.link} />
            <Button
              label={t("devices.ot.download")}
              onClick={() => download(filename, JSON.stringify(pairing.config, null, 2) + "\n")}
            />
          </HStack>
          <Hint>{t("devices.secretOnce")}</Hint>
        </VStack>
      </StackItem>
    </HStack>
  );
}

/** The server's QR code, redrawn from its path data; nothing from the response is inserted as markup. */
function QrCode({ svg, label }: { svg: string; label: string }) {
  const qr = qrFromSvg(svg);
  if (!qr) return null;
  return (
    <svg role="img" aria-label={label} viewBox={qr.viewBox} width={200} height={200} shapeRendering="crispEdges">
      {qr.paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill ?? (p.stroke ? "none" : undefined)} stroke={p.stroke} />
      ))}
    </svg>
  );
}

export function AgentsView() {
  const { t } = useApp();
  const [tokens, reload] = useTokens((k) => k.role !== "device");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ secret: string; mcp: string } | null>(null);
  const [busy, create] = useAction(async () => {
    const r = await api<{ secret: string; mcpConfig: unknown }>("/v1/tokens", { body: { name: name.trim(), role: "agent" } });
    setCreated({ secret: r.secret, mcp: JSON.stringify(r.mcpConfig, null, 2) });
    setName("");
    await reload();
  });
  return (
    <Page title={t("agents.title")} description={t("agents.desc")}>
      <Panel title={t("agents.create")}>
        <VStack gap={4}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <HStack gap={2} wrap="wrap" vAlign="end">
              <TextInput
                label={t("tokens.name")}
                placeholder={t("agents.namePlaceholder")}
                value={name}
                onChange={setName}
                isRequired
                width={280}
              />
              <Button type="submit" label={t("agents.createButton")} variant="primary" isLoading={busy} isDisabled={!name.trim()} />
            </HStack>
          </form>
          {created ? (
            <VStack gap={3}>
              <Banner status="success" title={t("agents.created")} />
              <Secret label={t("agents.token")} value={created.secret} />
              <Secret label={t("agents.mcpConfig")} value={created.mcp} language="json" />
              <Hint>{t("agents.mcpHint")}</Hint>
              <Hint>{t("devices.secretOnce")}</Hint>
            </VStack>
          ) : null}
        </VStack>
      </Panel>
      <Panel title={t("agents.list")}>
        <Loaded state={tokens}>{(list) => <TokenTable tokens={list} emptyText={t("agents.empty")} onChanged={reload} />}</Loaded>
      </Panel>
    </Page>
  );
}

