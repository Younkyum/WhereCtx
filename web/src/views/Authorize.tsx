/**
 * The OAuth consent screen an MCP client sends the person to
 * (`#authorize/<uid>`): who is asking, where the browser goes back to, and
 * what the app may read. Every authorization comes here; nothing is
 * remembered from an earlier one.
 */

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Code } from "@astryxdesign/core/Code";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { hostOf } from "../lib";
import type { ConsentRequest } from "../model";
import { Loaded, useLoad, useNotify } from "../ui";

const interactionPath = (uid: string, action: string) => `/oauth/interaction/${encodeURIComponent(uid)}/${action}`;

export function AuthorizeView({ uid }: { uid: string }) {
  const [request] = useLoad(() => api<ConsentRequest>(interactionPath(uid, "details")), [uid]);
  return (
    <Center padding={4}>
      <Card maxWidth={520} width="100%">
        <Loaded state={request}>{(r) => <Consent uid={uid} request={r} />}</Loaded>
      </Card>
    </Center>
  );
}

function Consent({ uid, request }: { uid: string; request: ConsentRequest }) {
  const { t } = useApp();
  const notify = useNotify();
  const [precise, setPrecise] = useState(false);
  const [pending, setPending] = useState<"confirm" | "abort" | null>(null);
  const client = request.client.name ?? request.client.id;
  const website = request.client.uri ? hostOf(request.client.uri) : null;

  const finish = async (action: "confirm" | "abort") => {
    setPending(action);
    try {
      const body = action === "confirm" ? { precise } : undefined;
      const { redirectTo } = await api<{ redirectTo: string }>(interactionPath(uid, action), { method: "POST", body });
      location.assign(redirectTo);
    } catch (e) {
      notify.fail(e);
      setPending(null);
    }
  };

  return (
    <VStack gap={5}>
      <VStack gap={1}>
        <Heading level={1}>{t("authorize.title", { client })}</Heading>
        <Text color="secondary">{t("authorize.desc", { client })}</Text>
      </VStack>
      <MetadataList columns="single" label={{ position: "start", width: 128 }}>
        <MetadataListItem label={t("authorize.app")}>
          <Text weight="semibold">{client}</Text>
        </MetadataListItem>
        {website ? (
          <MetadataListItem label={t("authorize.website")}>
            <Text>{website}</Text>
          </MetadataListItem>
        ) : null}
        <MetadataListItem label={t("authorize.redirect")}>
          <Code>{request.redirectHost}</Code>
        </MetadataListItem>
      </MetadataList>
      {request.localhostOnly ? (
        <Banner
          status="warning"
          title={t("authorize.local.title")}
          description={t("authorize.local.desc", { client })}
          collapsible={false}
        />
      ) : null}
      <VStack gap={3}>
        <Heading level={2}>{t("authorize.can")}</Heading>
        <Text>{t("authorize.presence")}</Text>
        {request.requestedScopes.includes("location:precise") ? (
          <CheckboxInput
            label={t("authorize.precise")}
            description={t("authorize.preciseDesc")}
            value={precise}
            onChange={setPrecise}
            isDisabled={pending !== null}
          />
        ) : null}
      </VStack>
      <HStack gap={2} hAlign="end" wrap="wrap">
        <Button
          label={t("authorize.deny")}
          variant="ghost"
          isLoading={pending === "abort"}
          isDisabled={pending === "confirm"}
          onClick={() => void finish("abort")}
        />
        <Button
          label={t("authorize.allow")}
          variant="primary"
          isLoading={pending === "confirm"}
          isDisabled={pending === "abort"}
          onClick={() => void finish("confirm")}
        />
      </HStack>
    </VStack>
  );
}
