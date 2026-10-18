/**
 * Everything before a session exists: sign in, first-time setup, invite
 * sign-up, recovery code, access code, then the one-time recovery codes or the
 * "add a passkey" prompt after recovery. Also the signed-in invite card.
 */

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MapPin } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { DisplayMenu } from "../App";
import { ApiError, api } from "../api";
import { addPasskey, enrollWithAccessCode, joinByInvite, recover, setUpOwner, signIn } from "../auth";
import { useApp } from "../context";
import type { I18nKey, Translate } from "../i18n";
import { webauthnProblem } from "../lib";
import type { InvitePreview } from "../model";
import { Hint, Loaded, RecoveryCodes, describe, useFormat, useLoad, useNotify } from "../ui";

type Step =
  | { kind: "signin" }
  | { kind: "setup" }
  | { kind: "invite"; token: string }
  | { kind: "recover" }
  | { kind: "access" }
  | { kind: "addPasskey" }
  | { kind: "codes"; codes: string[]; inviteUsed: boolean };

type EntryKind = "signin" | "setup" | "recover" | "access";

const ENTRY_LINKS: [EntryKind, I18nKey][] = [
  ["signin", "gate.signin.link"],
  ["setup", "gate.setup.link"],
  ["recover", "gate.recover.link"],
  ["access", "gate.access.link"],
];

/** Why a sign-in step failed. A 401 there is a wrong code or unknown passkey, not a lost session. */
function gateError(step: Step["kind"], e: unknown, t: Translate): string {
  const failed = step === "signin" || step === "setup" || step === "invite" || step === "recover" || step === "access";
  if (failed && e instanceof ApiError && e.status === 401) return t(`gate.err.${step}`);
  return describe(e, t);
}

function inviteProblem(e: unknown, t: Translate): string {
  if (e instanceof ApiError && e.status === 410) return t("gate.invite.gone");
  if (e instanceof ApiError && e.status === 401) return t("gate.invite.unknown");
  return describe(e, t);
}

export function Gate({ invite, onSignedIn }: { invite: string | null; onSignedIn: (inviteUsed: boolean) => void }) {
  const { t } = useApp();
  const [step, setStep] = useState<Step>(invite ? { kind: "invite", token: invite } : { kind: "signin" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const attempt = async (fn: () => Promise<void>) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(gateError(step.kind, e, t));
    } finally {
      setBusy(false);
    }
  };
  const showCodes = (codes: string[], inviteUsed = false) => go({ kind: "codes", codes, inviteUsed });

  const others = (except: EntryKind | null) => (
    <HStack gap={1} wrap="wrap">
      {ENTRY_LINKS.filter(([k]) => k !== except).map(([k, label]) => (
        <Button key={k} label={t(label)} variant="ghost" size="sm" onClick={() => go({ kind: k })} />
      ))}
    </HStack>
  );
  const errorBanner = error ? <Banner status="error" title={error} /> : null;

  let content: ReactNode;
  switch (step.kind) {
    case "signin":
      content = (
        <>
          <Head title={t("gate.signin.title")} description={t("gate.signin.desc")} />
          <PasskeyProblem />
          {errorBanner}
          <Button
            label={t("gate.signin.button")}
            variant="primary"
            width="100%"
            isLoading={busy}
            onClick={() => void attempt(async () => {
              await signIn();
              onSignedIn(false);
            })}
          />
          {others("signin")}
        </>
      );
      break;
    case "setup":
      content = (
        <>
          <Head title={t("gate.setup.title")} description={t("gate.setup.desc")} />
          <PasskeyProblem />
          {errorBanner}
          <CodeForm
            fields={[
              { name: "code", label: t("gate.setup.code"), autoComplete: "off" },
              { name: "displayName", label: t("gate.displayName"), autoComplete: "name" },
            ]}
            submit={t("gate.setup.button")}
            busy={busy}
            onSubmit={(v) =>
              attempt(async () => {
                const done = await setUpOwner(v.code!, v.displayName!);
                showCodes(done.recoveryCodes);
              })
            }
          />
          {others("setup")}
        </>
      );
      break;
    case "invite":
      content = <InviteSignUp token={step.token} busy={busy} error={errorBanner} attempt={attempt} go={go} showCodes={showCodes} others={others} />;
      break;
    case "recover":
      content = (
        <>
          <Head title={t("gate.recover.title")} description={t("gate.recover.desc")} />
          {errorBanner}
          <CodeForm
            fields={[{ name: "code", label: t("gate.recover.code"), autoComplete: "off" }]}
            submit={t("gate.recover.button")}
            busy={busy}
            onSubmit={(v) =>
              attempt(async () => {
                await recover(v.code!);
                go({ kind: "addPasskey" });
              })
            }
          />
          {others("recover")}
        </>
      );
      break;
    case "access":
      content = (
        <>
          <Head title={t("gate.access.title")} description={t("gate.access.desc")} />
          <PasskeyProblem />
          {errorBanner}
          <CodeForm
            fields={[{ name: "code", label: t("gate.access.code"), autoComplete: "off" }]}
            submit={t("gate.access.button")}
            busy={busy}
            onSubmit={(v) =>
              attempt(async () => {
                const done = await enrollWithAccessCode(v.code!);
                showCodes(done.recoveryCodes);
              })
            }
          />
          {others("access")}
        </>
      );
      break;
    case "addPasskey":
      content = <AddPasskeyStep busy={busy} error={errorBanner} attempt={attempt} onDone={() => onSignedIn(false)} />;
      break;
    case "codes":
      content = (
        <>
          <Head title={t("codes.title")} description={t("codes.desc")} />
          <RecoveryCodes codes={step.codes} onDone={() => onSignedIn(step.inviteUsed)} />
        </>
      );
      break;
  }

  return (
    <Center minHeight="100dvh" padding={4}>
      <VStack gap={4} width="100%" maxWidth={460}>
        <HStack hAlign="between" vAlign="center">
          <HStack gap={2} vAlign="center">
            <Icon icon={MapPin} />
            <Text type="large" weight="semibold">
              WhereCtx
            </Text>
          </HStack>
          <DisplayMenu />
        </HStack>
        <Card>
          <VStack gap={4}>{content}</VStack>
        </Card>
      </VStack>
    </Center>
  );
}

function Head({ title, description }: { title: string; description?: string }) {
  return (
    <VStack gap={1}>
      <Heading level={1}>{title}</Heading>
      {description ? <Text color="secondary">{description}</Text> : null}
    </VStack>
  );
}

/** Says up front when this page cannot use passkeys at all (plain http, old browser). */
function PasskeyProblem() {
  const { t } = useApp();
  const problem = webauthnProblem(window);
  if (!problem) return null;
  return (
    <Banner
      status="warning"
      title={t(problem === "insecure" ? "gate.insecure.title" : "gate.unsupported.title")}
      description={problem === "insecure" ? t("gate.insecure", { origin: location.origin }) : t("gate.unsupported")}
    />
  );
}

interface FieldSpec {
  name: string;
  label: string;
  autoComplete: string;
}

function CodeForm({
  fields,
  submit,
  busy,
  onSubmit,
}: {
  fields: FieldSpec[];
  submit: string;
  busy: boolean;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = fields.every((f) => (values[f.name] ?? "").trim() !== "");
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!filled || busy) return;
    onSubmit(Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? "").trim()])));
  };
  return (
    <form onSubmit={send}>
      <VStack gap={3}>
        {fields.map((f) => (
          <TextInput
            key={f.name}
            label={f.label}
            value={values[f.name] ?? ""}
            onChange={(v) => setValues((old) => ({ ...old, [f.name]: v }))}
            autoComplete={f.autoComplete}
            htmlName={f.name}
            isRequired
          />
        ))}
        <Button type="submit" label={submit} variant="primary" width="100%" isLoading={busy} isDisabled={!filled} />
      </VStack>
    </form>
  );
}

function InviteSignUp({
  token,
  busy,
  error,
  attempt,
  go,
  showCodes,
  others,
}: {
  token: string;
  busy: boolean;
  error: ReactNode;
  attempt: (fn: () => Promise<void>) => Promise<void>;
  go: (step: Step) => void;
  showCodes: (codes: string[], inviteUsed: boolean) => void;
  others: (except: EntryKind | null) => ReactNode;
}) {
  const { t } = useApp();
  const preview = useInvitePreview(token);
  return (
    <>
      <Head title={t("gate.invite.title")} />
      {preview.kind === "error" ? (
        <>
          <Banner status="warning" title={preview.message} />
          {others(null)}
        </>
      ) : (
        <Loaded state={preview}>
          {(p) => (
            <VStack gap={4}>
              <PreviewText preview={p} />
              <PasskeyProblem />
              {error}
              <CodeForm
                fields={[{ name: "displayName", label: t("gate.displayName"), autoComplete: "name" }]}
                submit={t("gate.invite.button")}
                busy={busy}
                onSubmit={(v) =>
                  attempt(async () => {
                    const joined = await joinByInvite(token, v.displayName!);
                    showCodes(joined.recoveryCodes, true);
                  })
                }
              />
              <Button label={t("gate.invite.haveAccount")} variant="ghost" size="sm" onClick={() => go({ kind: "signin" })} />
            </VStack>
          )}
        </Loaded>
      )}
    </>
  );
}

/** The invite's workspace and role; a failure reads as why the link cannot be used. */
function useInvitePreview(token: string) {
  const { t } = useApp();
  const [preview] = useLoad(
    () =>
      api<InvitePreview>("/v1/auth/invite/preview", { body: { token }, public: true }).catch((e: unknown) => {
        throw new Error(inviteProblem(e, t));
      }),
    [token],
  );
  return preview;
}

function PreviewText({ preview }: { preview: InvitePreview }) {
  const { t } = useApp();
  const fmt = useFormat();
  return (
    <VStack gap={1}>
      <Text>{t("gate.invite.desc", { workspace: preview.workspaceName, role: t(`role.${preview.role}`) })}</Text>
      <Hint>{t("gate.invite.expires", { date: fmt.time(preview.expiresAt) })}</Hint>
    </VStack>
  );
}

function AddPasskeyStep({
  busy,
  error,
  attempt,
  onDone,
}: {
  busy: boolean;
  error: ReactNode;
  attempt: (fn: () => Promise<void>) => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useApp();
  const notify = useNotify();
  return (
    <>
      <Head title={t("gate.addPasskey.title")} description={t("gate.addPasskey.desc")} />
      <PasskeyProblem />
      {error}
      <Button
        label={t("gate.addPasskey.button")}
        variant="primary"
        width="100%"
        isLoading={busy}
        onClick={() =>
          void attempt(async () => {
            await addPasskey();
            notify.ok(t("account.passkeyAdded"));
            onDone();
          })
        }
      />
      <Button label={t("gate.addPasskey.skip")} variant="ghost" size="sm" onClick={onDone} />
    </>
  );
}

/** A signed-in person opening an invite link: preview, then join or dismiss. */
export function InviteAccept({ token, onClose }: { token: string; onClose: (next: string, workspaceId?: string) => void }) {
  const { t } = useApp();
  const notify = useNotify();
  const preview = useInvitePreview(token);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      const r = await api<{ workspace: { id: string; name: string } }>("/v1/workspaces/invites/accept", { body: { token } });
      notify.ok(t("gate.invite.joined", { workspace: r.workspace.name }));
      onClose("workspace", r.workspace.id);
    } catch (e) {
      notify.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Center padding={4}>
      <Card maxWidth={460} width="100%">
        <VStack gap={4}>
          <Head title={t("gate.invite.title")} />
          {preview.kind === "error" ? (
            <>
              <Banner status="warning" title={preview.message} />
              <Button label={t("common.close")} variant="ghost" onClick={() => onClose("home")} />
            </>
          ) : (
            <Loaded state={preview}>
              {(p) => (
                <VStack gap={4}>
                  <PreviewText preview={p} />
                  <Button
                    label={t("gate.invite.accept", { workspace: p.workspaceName })}
                    variant="primary"
                    width="100%"
                    isLoading={busy}
                    onClick={() => void accept()}
                  />
                  <Button label={t("common.notNow")} variant="ghost" onClick={() => onClose("home")} />
                </VStack>
              )}
            </Loaded>
          )}
        </VStack>
      </Card>
    </Center>
  );
}
