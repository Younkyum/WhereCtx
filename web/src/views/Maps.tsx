/**
 * Maps & routes: which provider answers routes and addresses (Kakao or
 * Naver), my own keys for them, what may leave the server with my location,
 * where the dashboard's map tiles come from, and a route to try, drawn on the
 * map. Keys are write-only here: the server answers a hint, never the key.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import type { I18nKey } from "../i18n";
import {
  GEO_FLAGS,
  GEO_PROVIDERS,
  oneOf,
  type Eta,
  type GeoCredential,
  type GeoProviderName,
  type GeoStatus,
  type KeyTest,
  type PrivacySettings,
} from "../model";
import { routeScene } from "../mapScene";
import { MapView, tileHost, useMapTiles } from "../MapView";
import { DialogForm, FormDialog, Hint, Loaded, Page, Panel, Row, Rows, useAction, useConfirm, useFormat, useLoad, useNotify } from "../ui";

/** Where each provider documents getting a key (checked 2026-10-19). */
const KEY_DOCS: Record<GeoProviderName, string> = {
  kakao: "https://developers.kakaomobility.com/guide/navi-api/start.html",
  naver: "https://api.ncloud-docs.com/docs/application-maps-overview",
};

/** The fields each provider's REST key form asks for, in order. */
const KEY_FIELDS: Record<GeoProviderName, readonly { kind: string; secret: boolean; label: I18nKey }[]> = {
  kakao: [{ kind: "restKey", secret: true, label: "maps.kind.kakao.restKey" }],
  naver: [
    { kind: "clientId", secret: false, label: "maps.kind.naver.clientId" },
    { kind: "clientSecret", secret: true, label: "maps.kind.naver.clientSecret" },
  ],
};

async function loadMaps() {
  const [status, privacy] = await Promise.all([
    api<GeoStatus>("/v1/geo"),
    api<{ settings: PrivacySettings }>("/v1/privacy").then((r) => r.settings),
  ]);
  return { status, privacy };
}

export function MapsView() {
  const { t } = useApp();
  const [state, reload] = useLoad(loadMaps, []);
  return (
    <Page title={t("maps.title")} description={t("maps.desc")}>
      <Loaded state={state}>
        {({ status, privacy }) => (
          <VStack gap={6}>
            <ProviderPanel status={status} privacy={privacy} onChanged={reload} />
            <SwitchesPanel privacy={privacy} onChanged={reload} />
            <Panel title={t("maps.keys")}>
              <Rows items={[...GEO_PROVIDERS]} keyOf={(p) => p}>
                {(p) => (
                  <KeyRow
                    provider={p}
                    saved={status.credentials.find((c) => c.provider === p)}
                    operator={status.operator.includes(p)}
                    onChanged={reload}
                  />
                )}
              </Rows>
            </Panel>
            <MapTilesPanel />
            {privacy.geoEnabled ? <TryRoute /> : null}
          </VStack>
        )}
      </Loaded>
    </Page>
  );
}

function ProviderPanel({ status, privacy, onChanged }: { status: GeoStatus; privacy: PrivacySettings; onChanged: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const active = status.active;
  const choose = async (value: string) => {
    const geoProvider = oneOf(GEO_PROVIDERS, value) ? value : null;
    try {
      await api("/v1/privacy", { method: "PUT", body: { geoProvider } });
      notify.ok(t("toast.saved"));
    } catch (e) {
      notify.fail(e);
    }
    await onChanged();
  };
  return (
    <Panel title={t("maps.provider")}>
      <VStack gap={3}>
        <HStack gap={2} wrap="wrap" vAlign="center">
          <Text>{active ? t(`maps.active.${active.source}`, { provider: t(`maps.p.${active.provider}`) }) : t("maps.active.none")}</Text>
          {active ? <Badge variant="success" label={t(`maps.p.${active.provider}`)} /> : <Badge variant="warning" label={t("maps.notSetUp")} />}
        </HStack>
        <Selector
          label={t("maps.choose")}
          value={privacy.geoProvider ?? "auto"}
          options={[
            { value: "auto", label: t("maps.choose.auto") },
            ...GEO_PROVIDERS.map((p) => ({ value: p, label: t(`maps.p.${p}`) })),
          ]}
          onChange={(v) => void choose(v)}
          width={260}
        />
        <Hint>{t("maps.providerHint")}</Hint>
      </VStack>
    </Panel>
  );
}

function SwitchesPanel({ privacy, onChanged }: { privacy: PrivacySettings; onChanged: () => Promise<void> }) {
  const { t } = useApp();
  const notify = useNotify();
  const set = async (key: (typeof GEO_FLAGS)[number], on: boolean) => {
    try {
      await api("/v1/privacy", { method: "PUT", body: { [key]: on } });
      notify.ok(t("toast.saved"));
    } catch (e) {
      notify.fail(e);
    }
    await onChanged();
  };
  return (
    <Panel title={t("maps.leaves")}>
      <VStack gap={4}>
        <Hint>{t("maps.leavesHint")}</Hint>
        {GEO_FLAGS.map((key) => (
          <Switch
            key={key}
            label={t(`maps.flag.${key}`)}
            description={t(`maps.flagDesc.${key}`)}
            value={Boolean(privacy[key])}
            isDisabled={key !== "geoEnabled" && !privacy.geoEnabled}
            changeAction={(on) => set(key, on)}
          />
        ))}
      </VStack>
    </Panel>
  );
}

function KeyRow({
  provider,
  saved,
  operator,
  onChanged,
}: {
  provider: GeoProviderName;
  saved: GeoCredential | undefined;
  operator: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useApp();
  const fmt = useFormat();
  const notify = useNotify();
  const confirm = useConfirm();
  const fields = KEY_FIELDS[provider];
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = fields.every((f) => (values[f.kind] ?? "").trim().length >= 8);
  const save = async () => {
    const body = Object.fromEntries(fields.map((f) => [f.kind, values[f.kind]!.trim()]));
    await api(`/v1/geo/credentials/${provider}`, { method: "PUT", body });
    notify.ok(t("maps.keySaved"));
    await onChanged();
  };
  const edit = (open: boolean) => {
    setValues({});
    setEditing(open);
  };
  const [refusal, setRefusal] = useState<Extract<KeyTest, { ok: false }> | null>(null);
  const [testing, test] = useAction(async () => {
    setRefusal(null);
    const r = await api<{ test: KeyTest }>(`/v1/geo/credentials/${provider}/test`, { method: "POST" });
    if (r.test.ok) notify.ok(t("maps.testOk", { place: r.test.label }));
    else if (r.test.code) setRefusal(r.test);
    else notify.fail(new Error(t("maps.testFailed", { why: r.test.message })));
    await onChanged();
  });
  const remove = async () => {
    const title = t("maps.removeConfirm", { provider: t(`maps.p.${provider}`) });
    if (!(await confirm({ title, action: t("common.delete") }))) return;
    try {
      await api(`/v1/geo/credentials/${provider}`, { method: "DELETE" });
      notify.ok(t("toast.deleted"));
    } catch (e) {
      notify.fail(e);
    }
    await onChanged();
  };
  const hint = saved ? fields.map((f) => saved.kinds[f.kind]).find(Boolean) : undefined;
  const subtitle = (
    <VStack gap={0.5}>
      <Text type="supporting">
        {saved
          ? t("maps.savedKey", { hint: hint ? `••••${hint}` : "••••" }) +
            (saved.lastUsedAt ? ` · ${t("maps.lastUsed", { when: fmt.time(saved.lastUsedAt) })}` : "")
          : operator
            ? t("maps.usingOperator")
            : t("maps.noKey")}
      </Text>
      {saved?.status === "unusable" ? (
        <Text type="supporting">{t("maps.unusable")}</Text>
      ) : saved?.lastError ? (
        <Text type="supporting">{t("maps.lastError", { why: saved.lastError })}</Text>
      ) : null}
      <Link href={KEY_DOCS[provider]} isExternalLink>
        {t(`maps.getKey.${provider}`)}
      </Link>
    </VStack>
  );
  return (
    <VStack gap={2}>
      <Row title={t(`maps.p.${provider}`)} subtitle={subtitle}>
        <Button label={t(saved ? "maps.replaceKey" : "maps.addKey")} size="sm" variant={saved ? "secondary" : "primary"} onClick={() => edit(true)} />
        {saved ? <Button label={t("maps.test")} size="sm" isLoading={testing} onClick={() => void test()} /> : null}
        {saved ? <Button label={t("common.delete")} size="sm" variant="destructive" clickAction={remove} /> : null}
      </Row>
      {refusal?.code ? <Refusal provider={provider} refusal={refusal} onDismiss={() => setRefusal(null)} /> : null}
      <FormDialog isOpen={editing} onClose={() => edit(false)}>
        <DialogForm
          title={t(saved ? "maps.replaceKeyTitle" : "maps.addKeyTitle", { provider: t(`maps.p.${provider}`) })}
          submitLabel={t("maps.saveKey")}
          canSubmit={complete}
          onSubmit={save}
          onClose={() => edit(false)}
        >
          {fields.map((f) => (
            <TextInput
              key={f.kind}
              label={t(f.label)}
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              value={values[f.kind] ?? ""}
              onChange={(v) => setValues({ ...values, [f.kind]: v })}
            />
          ))}
          <Hint>{t("maps.keyWriteOnly")}</Hint>
        </DialogForm>
      </FormDialog>
    </VStack>
  );
}

/** A key test the provider turned down: which API, what to fix, and what the provider said. */
function Refusal({ provider, refusal, onDismiss }: { provider: GeoProviderName; refusal: Extract<KeyTest, { ok: false }>; onDismiss: () => void }) {
  const { t } = useApp();
  const name = t(`maps.p.${provider}`);
  return (
    <Banner
      status="warning"
      title={t("maps.testRefused", { provider: name, api: t(`maps.testApi.${refusal.api ?? "geocoding"}`) })}
      description={
        <VStack gap={1}>
          <Text>{t(`maps.problem.${provider}.${refusal.code ?? "upstream"}`)}</Text>
          {refusal.providerMessage ? <Text type="supporting">{t("maps.providerSaid", { provider: name, words: refusal.providerMessage })}</Text> : null}
        </VStack>
      }
      isDismissable
      onDismiss={onDismiss}
    />
  );
}

/** Where the dashboard's maps come from, and what that tile server sees. */
function MapTilesPanel() {
  const { t } = useApp();
  const tiles = useMapTiles();
  if (tiles === undefined) return null;
  return (
    <Panel title={t("maps.mapTiles")}>
      <Hint>{tiles ? t("maps.mapTilesPrivacy", { host: tileHost(tiles.url) }) : t("maps.mapTilesOff")}</Hint>
    </Panel>
  );
}

/** A route from where I am now, as an agent would get it. */
function TryRoute() {
  const { t } = useApp();
  const fmt = useFormat();
  const [to, setTo] = useState("");
  const [eta, setEta] = useState<Eta | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, run] = useAction(async () => {
    setProblem(null);
    setEta(null);
    try {
      setEta((await api<{ eta: Eta }>(`/v1/geo/eta?to=${encodeURIComponent(to.trim())}`)).eta);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  });
  return (
    <Panel title={t("maps.try")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (to.trim()) void run();
        }}
      >
        <VStack gap={3}>
          <HStack gap={2} wrap="wrap" vAlign="end">
            <TextInput label={t("maps.tryTo")} value={to} onChange={setTo} width={300} />
            <Button type="submit" label={t("maps.tryGo")} variant="primary" isLoading={busy} isDisabled={!to.trim()} />
          </HStack>
          <Hint>{t("maps.tryHint")}</Hint>
          {problem ? <Banner status="warning" title={problem} /> : null}
          {eta?.path?.length ? <RouteMap eta={eta} /> : null}
          {eta ? (
            <VStack gap={1}>
              <Text weight="semibold">
                {t("maps.etaLine", { min: eta.durationMin, km: eta.distanceKm, place: eta.destination.label })}
              </Text>
              <Text type="supporting">
                {[
                  t(eta.traffic === "live" ? "maps.live" : "maps.predicted"),
                  t("maps.arrive", { when: fmt.time(eta.arriveAt) }),
                  t(`maps.from.${eta.origin}`),
                  eta.summary.join(" · "),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {eta.deepLinks ? (
                <HStack gap={3}>
                  <Link href={eta.deepLinks.kakaoMap} isExternalLink>
                    {t("maps.openKakao")}
                  </Link>
                </HStack>
              ) : null}
            </VStack>
          ) : null}
        </VStack>
      </form>
    </Panel>
  );
}

function RouteMap({ eta }: { eta: Eta }) {
  const { t } = useApp();
  const tiles = useMapTiles();
  const scene = useMemo(() => routeScene(eta.path ?? [], eta.destination.label, t("map.start")), [eta, t]);
  return <MapView tiles={tiles} scene={scene} />;
}
