/**
 * Connecting phones (OwnTracks by QR code, the iOS Shortcut by URL and
 * header) and agents (a token plus its MCP config). Secrets appear once, right
 * after creation; the lists show tokens without them.
 */

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
import type { ApiToken, Pairing } from "../model";
import { Empty, Hint, Loaded, Page, Panel, Secret, download, useAction, useConfirm, useLoad, useNotify } from "../ui";

function useTokens(keep: (k: ApiToken) => boolean) {
  return useLoad(() => api<{ tokens: ApiToken[] }>("/v1/tokens").then((r) => (r.tokens ?? []).filter(keep)), []);
}

function TokenTable({ tokens, emptyText, onChanged }: { tokens: ApiToken[]; emptyText: string; onChanged: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
  if (!tokens.length) return <Empty text={emptyText} />;
  const revoke = async (k: ApiToken) => {
    if (!(await confirm({ title: t("tokens.revokeConfirm", { name: k.name }), action: t("common.revoke") }))) return;
    try {
      await api(`/v1/tokens/${encodeURIComponent(k.id)}`, { method: "DELETE" });
      notify.ok(t("toast.revoked"));
    } catch (e) {
      notify.fail(e);
    }
    await onChanged();
  };
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

export function DevicesView() {
  const { t } = useApp();
  const [tokens, reload] = useTokens((k) => k.role === "device");
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
      <Panel title={t("devices.list")}>
        <Loaded state={tokens}>{(list) => <TokenTable tokens={list} emptyText={t("devices.empty")} onChanged={reload} />}</Loaded>
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

