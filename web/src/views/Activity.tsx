/**
 * Who read my location: every agent or token request for my presence data,
 * on REST and MCP, with what it asked, whether it was allowed, and the reason
 * it gave for an exact location. My own views in this dashboard are not here.
 */

import { Badge, type BadgeProps } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { ACCESS_ACTIONS, oneOf, type AccessEntry, type AccessOutcome, type ApiToken } from "../model";
import { Empty, Hint, Loaded, Page, Panel, Row, Rows, useFormat, useLoad, usePaged } from "../ui";

export const OUTCOME_BADGE: Record<AccessOutcome, BadgeProps["variant"]> = {
  allowed: "success",
  denied: "error",
  hidden: "neutral",
};

const ALL = "all";

export function ActivityView() {
  const { t } = useApp();
  const [credential, setCredential] = useState(ALL);
  const [tokens] = useLoad(() => api<{ tokens: ApiToken[] }>("/v1/tokens").then((r) => r.tokens ?? []), []);
  const query = credential === ALL ? "" : `&credential=${encodeURIComponent(credential)}`;
  const log = usePaged<AccessEntry>(`/v1/activity/access?limit=50${query}`);
  const options = [
    { value: ALL, label: t("activity.allCredentials") },
    ...(tokens.kind === "ready" ? tokens.data.map((k) => ({ value: k.id, label: k.name })) : []),
  ];
  return (
    <Page title={t("activity.title")} description={t("activity.desc")}>
      <Panel
        title={t("activity.reads")}
        actions={<Selector label={t("activity.filter")} isLabelHidden value={credential} options={options} onChange={setCredential} width={220} />}
      >
        <VStack gap={3}>
          <Loaded state={log.state}>
            {(entries) => (entries.length ? <AccessRows entries={entries} /> : <Empty text={t("activity.empty")} />)}
          </Loaded>
          {log.hasMore ? (
            <HStack>
              <Button label={t("activity.more")} isLoading={log.loadingMore} onClick={() => void log.more()} />
            </HStack>
          ) : null}
          <Hint>{t("activity.note")}</Hint>
        </VStack>
      </Panel>
    </Page>
  );
}

function AccessRows({ entries }: { entries: AccessEntry[] }) {
  const { t } = useApp();
  const format = useFormat();
  return (
    <Rows items={entries} keyOf={(e) => e.id}>
      {(e) => (
        <Row
          title={
            <HStack gap={2} wrap="wrap" vAlign="center">
              <Text weight="semibold">{oneOf(ACCESS_ACTIONS, e.action) ? t(`access.action.${e.action}`) : e.action}</Text>
              <Badge variant={OUTCOME_BADGE[e.outcome] ?? "neutral"} label={t(`access.outcome.${e.outcome}`)} />
              {e.precise ? <Badge variant="warning" label={t("access.precise")} /> : null}
            </HStack>
          }
          subtitle={
            <VStack gap={0.5}>
              <Text type="supporting">
                {[e.credential.name, t(`access.surface.${e.surface}`), format.time(e.createdAt)].join(" · ")}
              </Text>
              {e.reason ? <Text type="supporting">{t("access.reason", { reason: e.reason })}</Text> : null}
              {e.denial ? <Text type="supporting">{t("access.denial", { denial: e.denial })}</Text> : null}
            </VStack>
          }
        />
      )}
    </Rows>
  );
}
