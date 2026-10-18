/**
 * Who sees me (one row per person I share a workspace with: off, status only
 * or exact, and hide-at-home), who I see (decline), the pause-everything
 * switch, and my shares' audit log.
 */

import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/Layout";
import { api } from "../api";
import { useApp, useMe } from "../context";
import { SHARE_LEVELS, oneOf, type AuditEntry, type PrivacySettings, type ShareLevel, type ShareTerms, type Shares } from "../model";
import { Empty, Loaded, Page, Panel, Row, Rows, useConfirm, useLoad, useNotify } from "../ui";

interface CoMember {
  id: string;
  name: string;
  spaces: string[];
}

/** Everyone I share at least one workspace with, with those workspaces' names. */
async function coMembers(myId: string): Promise<CoMember[]> {
  const spaces = (await api<{ workspaces: { id: string; name: string }[] }>("/v1/workspaces")).workspaces;
  const lists = await Promise.all(
    spaces.map((w) =>
      api<{ members: { userId: string; displayName: string }[] }>(`/v1/workspaces/${encodeURIComponent(w.id)}/members`).then(
        (r) => ({ ws: w, members: r.members }),
      ),
    ),
  );
  const byId = new Map<string, CoMember>();
  for (const { ws, members } of lists) {
    for (const m of members) {
      if (m.userId === myId) continue;
      const entry = byId.get(m.userId) ?? { id: m.userId, name: m.displayName, spaces: [] };
      entry.spaces.push(ws.name);
      byId.set(m.userId, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadSharing(myId: string) {
  const [shares, people, privacy, audit] = await Promise.all([
    api<Shares>("/v1/shares"),
    coMembers(myId),
    api<{ settings: PrivacySettings }>("/v1/privacy"),
    api<{ audit: AuditEntry[] }>("/v1/shares/audit?limit=50"),
  ]);
  return { shares, people, paused: Boolean(privacy.settings?.sharingPaused), audit: audit.audit ?? [] };
}

export function SharingView() {
  const { t } = useApp();
  const me = useMe();
  const notify = useNotify();
  const confirm = useConfirm();
  const [state, reload] = useLoad(() => loadSharing(me.user.id), [me.user.id]);

  const change = async (fn: () => Promise<unknown>, message = t("toast.saved")) => {
    try {
      await fn();
      notify.ok(message);
    } catch (e) {
      notify.fail(e);
    } finally {
      await reload();
    }
  };
  const share = (id: string) => `/v1/shares/${encodeURIComponent(id)}`;

  return (
    <Page title={t("sharing.title")} description={t("sharing.desc")}>
      <Loaded state={state}>
        {({ shares, people, paused, audit }) => {
          const outgoing = new Map(shares.outgoing.map((s) => [s.viewer.id, s]));
          return (
            <VStack gap={6}>
              <Panel title={t("sharing.pause.title")}>
                <Switch
                  label={t("sharing.pause.label")}
                  description={t("sharing.pause.desc")}
                  value={paused}
                  changeAction={(on) =>
                    change(
                      () => api("/v1/privacy", { method: "PUT", body: { sharingPaused: on } }),
                      t(on ? "sharing.pausedOn" : "sharing.pausedOff"),
                    )
                  }
                />
              </Panel>
              <Panel title={t("sharing.outgoing")}>
                {people.length ? (
                  <Rows items={people} keyOf={(p) => p.id}>
                    {(p) => {
                      const current = outgoing.get(p.id);
                      const level: ShareLevel = current?.level ?? "off";
                      return (
                        <Row title={p.name} subtitle={p.spaces.join(", ")}>
                          <Selector
                            label={t("sharing.levelFor", { name: p.name })}
                            isLabelHidden
                            width={190}
                            value={level}
                            options={SHARE_LEVELS.map((l) => ({ value: l, label: t(`sharing.level.${l}`) }))}
                            onChange={(next) => {
                              if (!oneOf(SHARE_LEVELS, next) || next === level) return;
                              void change(() =>
                                next === "off"
                                  ? api(share(p.id), { method: "DELETE" })
                                  : api(share(p.id), { method: "PUT", body: { level: next } }),
                              );
                            }}
                          />
                          {current?.level === "precise" ? (
                            <Switch
                              size="sm"
                              label={t("sharing.hideHome")}
                              value={Boolean(current.hideHomeExact)}
                              changeAction={(on) =>
                                change(() => api(share(p.id), { method: "PUT", body: { level: "precise", hideHomeExact: on } }))
                              }
                            />
                          ) : null}
                        </Row>
                      );
                    }}
                  </Rows>
                ) : (
                  <Empty text={t("sharing.noMembers")} />
                )}
              </Panel>
              <Panel title={t("sharing.incoming")}>
                {shares.incoming.length ? (
                  <Rows items={shares.incoming} keyOf={(s) => s.owner.id}>
                    {(s) => (
                      <Row title={s.owner.displayName} subtitle={t(`sharing.level.${s.level}`)}>
                        <Button
                          label={t("sharing.decline")}
                          variant="destructive"
                          size="sm"
                          clickAction={async () => {
                            const ok = await confirm({
                              title: t("sharing.declineConfirm", { name: s.owner.displayName }),
                              action: t("sharing.decline"),
                            });
                            if (ok) await change(() => api(`/v1/shares/incoming/${encodeURIComponent(s.owner.id)}`, { method: "DELETE" }));
                          }}
                        />
                      </Row>
                    )}
                  </Rows>
                ) : (
                  <Empty text={t("sharing.noIncoming")} />
                )}
              </Panel>
              <Panel title={t("sharing.audit")}>
                <AuditTable audit={audit} />
              </Panel>
            </VStack>
          );
        }}
      </Loaded>
    </Page>
  );
}

function AuditTable({ audit }: { audit: AuditEntry[] }) {
  const { t } = useApp();
  if (!audit.length) return <Empty text={t("audit.empty")} />;
  const terms = (x: ShareTerms | null | undefined) =>
    !x ? "" : t(x.level === "precise" && x.hideHomeExact ? "sharing.terms.preciseHomeHidden" : `sharing.level.${x.level}`);
  const detail = (a: AuditEntry) => {
    let d = a.action === "changed" ? `${terms(a.before)} → ${terms(a.after)}` : a.action === "granted" ? terms(a.after) : "";
    if (a.reason) d += (d ? " · " : "") + t(`audit.reason.${a.reason}`);
    return d;
  };
  const rows = audit.map((a, i) => ({ ...a, key: a.id ?? String(i) }));
  return (
    <Table
      data={rows}
      idKey="key"
      verticalAlign="top"
      columns={[
        { key: "createdAt", header: t("audit.when"), renderCell: (a) => <Timestamp value={a.createdAt} format="date_time" /> },
        { key: "viewer", header: t("audit.who"), renderCell: (a) => a.viewer?.displayName ?? "" },
        {
          key: "action",
          header: t("audit.what"),
          renderCell: (a) => (
            <VStack gap={0}>
              <Text>{t(`audit.action.${a.action}`)}</Text>
              {detail(a) ? <Text type="supporting">{detail(a)}</Text> : null}
            </VStack>
          ),
        },
      ]}
    />
  );
}
