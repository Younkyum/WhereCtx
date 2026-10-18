/**
 * Display name, passkeys, signed-in devices, recovery codes and sign-out.
 * Passkey and recovery changes need a recent passkey proof; api() runs that
 * step-up and retries once.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import { api } from "../api";
import { addPasskey } from "../auth";
import { useApp, useMe } from "../context";
import { deviceLabel } from "../lib";
import type { Me } from "../model";
import { Empty, Hint, Page, Panel, RecoveryCodes, Row, Rows, useAction, useConfirm, useFormat, useNotify } from "../ui";

export function AccountView() {
  const { t, refreshMe, signOut } = useApp();
  const me = useMe();
  const notify = useNotify();
  const confirm = useConfirm();
  const fmt = useFormat();
  const [name, setName] = useState(me.user.displayName);
  const [codes, setCodes] = useState<string[] | null>(null);

  const [renaming, rename] = useAction(async () => {
    await api("/v1/me", { method: "PATCH", body: { displayName: name.trim() } });
    notify.ok(t("toast.saved"));
    await refreshMe();
  });
  const [adding, add] = useAction(async () => {
    await addPasskey();
    notify.ok(t("account.passkeyAdded"));
    await refreshMe();
  });
  const guarded = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      notify.fail(e);
    }
  };
  const deletePasskey = (p: Me["passkeys"][number]) =>
    guarded(async () => {
      if (!(await confirm({ title: t("account.passkeyDeleteConfirm", { name: p.name }), action: t("common.delete") }))) return;
      await api(`/v1/me/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      notify.ok(t("toast.deleted"));
      await refreshMe();
    });
  const endSession = (s: Me["sessions"][number]) =>
    guarded(async () => {
      const title = t(s.current ? "account.signOutConfirm" : "account.endSessionConfirm");
      const action = t(s.current ? "account.signOut" : "common.revoke");
      if (!(await confirm({ title, action, isDestructive: !s.current, description: s.current ? t("account.signOutDesc") : undefined }))) return;
      await api(`/v1/me/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      if (s.current) {
        await signOut(false);
        return;
      }
      notify.ok(t("toast.revoked"));
      await refreshMe();
    });
  const endOthers = guarded(async () => {
    if (!(await confirm({ title: t("account.endOthersConfirm"), action: t("account.endOthers") }))) return;
    const r = await api<{ revoked: number }>("/v1/me/sessions/revoke-others", { method: "POST" });
    notify.ok(t("account.endedOthers", { n: r.revoked }));
    await refreshMe();
  });
  const newCodes = guarded(async () => {
    if (!(await confirm({ title: t("account.codesConfirm"), action: t("account.newCodes") }))) return;
    const r = await api<{ recoveryCodes: string[] }>("/v1/me/recovery-codes", { method: "POST" });
    setCodes(r.recoveryCodes);
  });

  const single = me.passkeys.length <= 1;
  const workspaces = me.workspaces.map((w) => t("account.workspaceItem", { name: w.name, role: t(`role.${w.role}`) })).join(", ");

  return (
    <Page title={t("account.title")}>
      <Panel title={t("account.profile")}>
        <VStack gap={4}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void rename();
            }}
          >
            <HStack gap={2} wrap="wrap" vAlign="end">
              <TextInput label={t("account.displayName")} value={name} onChange={setName} isRequired width={280} autoComplete="name" />
              <Button type="submit" label={t("common.save")} variant="primary" isLoading={renaming} isDisabled={!name.trim()} />
            </HStack>
          </form>
          {workspaces ? <Hint>{t("account.workspaces", { list: workspaces })}</Hint> : null}
          <HStack>
            <Button label={t("account.signOut")} clickAction={() => signOut(true)} />
          </HStack>
        </VStack>
      </Panel>
      <Panel
        title={t("account.passkeys")}
        actions={<Button label={t("account.addPasskey")} size="sm" isLoading={adding} onClick={() => void add()} />}
      >
        {me.passkeys.length ? (
          <VStack gap={2}>
            <Rows items={me.passkeys} keyOf={(p) => p.id}>
              {(p) => (
                <Row
                  title={p.name}
                  subtitle={t("account.passkeyMeta", { created: fmt.date(p.createdAt), used: p.lastUsedAt ? fmt.time(p.lastUsedAt) : t("tokens.never") })}
                >
                  {single ? null : <Button label={t("common.delete")} variant="destructive" size="sm" clickAction={deletePasskey(p)} />}
                </Row>
              )}
            </Rows>
            {single ? <Hint>{t("account.lastPasskeyHint")}</Hint> : null}
          </VStack>
        ) : (
          <Empty text={t("account.noPasskeys")} />
        )}
      </Panel>
      <Panel
        title={t("account.sessions")}
        actions={me.sessions.length > 1 ? <Button label={t("account.endOthers")} size="sm" clickAction={endOthers} /> : undefined}
      >
        <Rows items={me.sessions} keyOf={(s) => s.id}>
          {(s) => (
            <Row
              title={
                <HStack gap={2} vAlign="center" wrap="wrap">
                  {deviceLabel(s.userAgent) || t("account.unknownDevice")}
                  {s.current ? <Badge variant="info" label={t("account.thisDevice")} /> : null}
                </HStack>
              }
              subtitle={t("account.sessionMeta", { created: fmt.date(s.createdAt), seen: fmt.time(s.lastSeenAt) })}
            >
              <Button
                label={t(s.current ? "account.signOut" : "common.revoke")}
                variant={s.current ? "secondary" : "destructive"}
                size="sm"
                clickAction={endSession(s)}
              />
            </Row>
          )}
        </Rows>
      </Panel>
      <Panel title={t("account.recovery")}>
        <VStack gap={3}>
          <Hint>{t("account.recoveryDesc")}</Hint>
          {codes ? (
            <RecoveryCodes
              codes={codes}
              onDone={() => {
                setCodes(null);
                notify.ok(t("toast.saved"));
              }}
            />
          ) : (
            <HStack>
              <Button label={t("account.newCodes")} clickAction={newCodes} />
            </HStack>
          )}
        </VStack>
      </Panel>
    </Page>
  );
}
