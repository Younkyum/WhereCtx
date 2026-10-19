/**
 * My workspaces: the selected one's members and invites, rename, leave, and
 * creating a workspace. Controls follow the server's role registry, so nobody
 * sees a button they cannot use.
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useState, type ReactNode } from "react";
import { WORKSPACE_ROLES, can } from "../../../src/accounts/types";
import { ApiError, api } from "../api";
import { useApp, useMe } from "../context";
import { inviteRoles, memberActions } from "../lib";
import { oneOf, type Invite, type Member, type WorkspaceMembership, type WorkspaceRole } from "../model";
import { DialogForm, DialogResult, Empty, FormDialog, Loaded, Page, Panel, Row, Rows, Secret, useConfirm, useFormat, useLoad, useNotify } from "../ui";

const PICK_KEY = "wherectx_workspace";

function storedPick(): string | null {
  try {
    return localStorage.getItem(PICK_KEY);
  } catch {
    return null;
  }
}

/** Select a workspace for the next render (after accepting an invite). */
export function selectWorkspace(id: string | null): void {
  try {
    if (id) localStorage.setItem(PICK_KEY, id);
    else localStorage.removeItem(PICK_KEY);
  } catch {
    /* storage blocked: the first workspace shows instead */
  }
}

/** Which form the dialog holds, if any. */
type WorkspaceDialog = { kind: "rename" } | { kind: "role"; member: Member } | null;

export function WorkspaceView() {
  const { t } = useApp();
  const [picked, setPicked] = useState(storedPick);
  const [spaces, reload] = useLoad(
    () => api<{ workspaces: WorkspaceMembership[] }>("/v1/workspaces").then((r) => r.workspaces ?? []),
    [],
  );
  const [creating, setCreating] = useState(false);
  const pick = (id: string | null) => {
    selectWorkspace(id);
    setPicked(id);
  };
  const close = () => setCreating(false);
  const newButton = <Button label={t("ws.create")} onClick={() => setCreating(true)} />;
  return (
    <Page title={t("ws.title")} description={t("ws.desc")}>
      <Loaded state={spaces}>
        {(list) => {
          const ws = list.find((w) => w.id === picked) ?? list[0];
          return ws ? (
            <CurrentWorkspace key={ws.id} ws={ws} all={list} onPick={pick} onChanged={reload} newButton={newButton} />
          ) : (
            <VStack gap={3}>
              <Empty text={t("ws.none")} />
              <HStack>{newButton}</HStack>
            </VStack>
          );
        }}
      </Loaded>
      <FormDialog isOpen={creating} onClose={close}>
        <CreateWorkspace
          onClose={close}
          onCreated={async (id) => {
            pick(id);
            await reload();
          }}
        />
      </FormDialog>
    </Page>
  );
}

function CurrentWorkspace({
  ws,
  all,
  onPick,
  onChanged,
  newButton,
}: {
  ws: WorkspaceMembership;
  all: WorkspaceMembership[];
  onPick: (id: string | null) => void;
  onChanged: () => Promise<void>;
  newButton: ReactNode;
}) {
  const { t, refreshMe } = useApp();
  const me = useMe();
  const notify = useNotify();
  const confirm = useConfirm();
  const fmt = useFormat();
  const base = `/v1/workspaces/${encodeURIComponent(ws.id)}`;
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const close = () => setDialog(null);
  const [members, reloadMembers] = useLoad(() => api<{ members: Member[] }>(`${base}/members`).then((r) => r.members ?? []), [base]);
  const leave = async () => {
    if (!(await confirm({ title: t("ws.leaveConfirm", { name: ws.name }), action: t("ws.leave") }))) return;
    try {
      await api(`${base}/members/${encodeURIComponent(me.user.id)}`, { method: "DELETE" });
      onPick(null);
      notify.ok(t("ws.left"));
      await refreshMe();
      await onChanged();
    } catch (e) {
      notify.fail(e);
    }
  };
  const remove = async (m: Member) => {
    if (!(await confirm({ title: t("ws.removeConfirm", { name: m.displayName }), action: t("ws.remove") }))) return;
    try {
      await api(`${base}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
      notify.ok(t("toast.removed"));
    } catch (e) {
      notify.fail(e);
    }
    await reloadMembers();
  };
  const invitable = inviteRoles(ws.role);

  return (
    <VStack gap={6}>
      <Panel
        title={t("ws.overview")}
        actions={
          <HStack gap={2} wrap="wrap">
            {can(ws.role, "rename") ? <Button label={t("ws.rename")} onClick={() => setDialog({ kind: "rename" })} /> : null}
            {newButton}
          </HStack>
        }
      >
        <VStack gap={4}>
          <HStack gap={3} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              <VStack gap={0.5}>
                <Text type="supporting">{t("ws.current")}</Text>
                <Heading level={3}>{ws.name}</Heading>
                <Text type="supporting">{t("ws.yourRole", { role: t(`role.${ws.role}`) })}</Text>
              </VStack>
            </StackItem>
            <Button label={t("ws.leave")} variant="destructive" clickAction={leave} />
          </HStack>
          {all.length > 1 ? (
            <Selector
              label={t("ws.switch")}
              value={ws.id}
              options={all.map((w) => ({ value: w.id, label: `${w.name} · ${t(`role.${w.role}`)}` }))}
              onChange={(id) => onPick(id)}
              width={320}
            />
          ) : null}
        </VStack>
      </Panel>
      <Panel title={t("ws.members")}>
        <Loaded state={members}>
          {(list) => (
            <Rows items={list} keyOf={(m) => m.userId}>
              {(m) => {
                const a = memberActions(ws.role, me.user.id, m);
                return (
                  <Row
                    title={
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        {m.displayName}
                        {a.self ? <Badge label={t("ws.you")} /> : null}
                      </HStack>
                    }
                    subtitle={`${t("ws.joined")} ${fmt.date(m.joinedAt)}`}
                  >
                    <Text>{t(`role.${m.role}`)}</Text>
                    {a.changeRole ? <Button label={t("ws.changeRole")} size="sm" onClick={() => setDialog({ kind: "role", member: m })} /> : null}
                    {a.remove ? <Button label={t("ws.remove")} variant="destructive" size="sm" clickAction={() => remove(m)} /> : null}
                  </Row>
                );
              }}
            </Rows>
          )}
        </Loaded>
      </Panel>
      {invitable.length ? <Invites base={base} myRole={ws.role} roles={invitable} /> : null}
      <FormDialog isOpen={dialog !== null} onClose={close}>
        {dialog?.kind === "rename" ? (
          <RenameWorkspace ws={ws} base={base} onClose={close} onSaved={onChanged} />
        ) : dialog?.kind === "role" ? (
          <ChangeRole
            member={dialog.member}
            choices={memberActions(ws.role, me.user.id, dialog.member).roleChoices}
            base={base}
            onClose={close}
            onSaved={reloadMembers}
          />
        ) : null}
      </FormDialog>
    </VStack>
  );
}

function RenameWorkspace({ ws, base, onClose, onSaved }: { ws: WorkspaceMembership; base: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t, refreshMe } = useApp();
  const notify = useNotify();
  const [name, setName] = useState(ws.name);
  const save = async () => {
    await api(base, { method: "PATCH", body: { name: name.trim() } });
    notify.ok(t("toast.saved"));
    await refreshMe();
    await onSaved();
  };
  return (
    <DialogForm
      title={t("ws.renameTitle")}
      submitLabel={t("common.save")}
      canSubmit={name.trim() !== "" && name.trim() !== ws.name}
      onSubmit={save}
      onClose={onClose}
    >
      <TextInput label={t("ws.name")} value={name} onChange={setName} isRequired />
    </DialogForm>
  );
}

function ChangeRole({
  member,
  choices,
  base,
  onClose,
  onSaved,
}: {
  member: Member;
  choices: WorkspaceRole[];
  base: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useApp();
  const notify = useNotify();
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const save = async () => {
    await api(`${base}/members/${encodeURIComponent(member.userId)}`, { method: "PATCH", body: { role } });
    notify.ok(t("toast.saved"));
    await onSaved();
  };
  return (
    <DialogForm
      title={t("ws.roleTitle", { name: member.displayName })}
      submitLabel={t("common.save")}
      canSubmit={role !== member.role}
      onSubmit={save}
      onClose={onClose}
    >
      <Selector
        label={t("ws.role")}
        value={role}
        options={choices.map((r) => ({ value: r, label: t(`role.${r}`) }))}
        onChange={(r) => oneOf(WORKSPACE_ROLES, r) && setRole(r)}
      />
    </DialogForm>
  );
}

function CreateInvite({ base, roles, onClose, onCreated }: { base: string; roles: WorkspaceRole[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const { t } = useApp();
  const fmt = useFormat();
  const [role, setRole] = useState<WorkspaceRole>(roles.includes("member") ? "member" : roles[0]!);
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const create = async () => {
    setCreated(await api<{ url: string; expiresAt: string }>(`${base}/invites`, { body: { role } }));
    await onCreated();
  };
  if (created) {
    return (
      <DialogResult title={t("ws.inviteReady")} onClose={onClose}>
        <Text>{t("ws.inviteCreated", { date: fmt.time(created.expiresAt) })}</Text>
        <Secret label={t("ws.inviteLink")} value={created.url} />
      </DialogResult>
    );
  }
  return (
    <DialogForm title={t("ws.inviteTitle")} submitLabel={t("ws.inviteButton")} canSubmit keepOpen onSubmit={create} onClose={onClose}>
      <Selector
        label={t("ws.inviteRole")}
        value={role}
        options={roles.map((r) => ({ value: r, label: t(`role.${r}`) }))}
        onChange={(r) => oneOf(WORKSPACE_ROLES, r) && setRole(r)}
      />
    </DialogForm>
  );
}

function Invites({ base, myRole, roles }: { base: string; myRole: WorkspaceRole; roles: WorkspaceRole[] }) {
  const { t } = useApp();
  const notify = useNotify();
  const confirm = useConfirm();
  const [inviting, setInviting] = useState(false);
  const [invites, reload] = useLoad(() => api<{ invites: Invite[] }>(`${base}/invites`).then((r) => r.invites ?? []), [base]);
  const close = () => setInviting(false);
  const revoke = async (i: Invite) => {
    if (!(await confirm({ title: t("ws.revokeInviteConfirm"), action: t("common.revoke") }))) return;
    try {
      await api(`${base}/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" });
      notify.ok(t("toast.revoked"));
    } catch (e) {
      notify.fail(e);
    }
    await reload();
  };
  return (
    <Panel title={t("ws.invites")} actions={<Button label={t("ws.inviteButton")} variant="primary" onClick={() => setInviting(true)} />}>
      <Loaded state={invites}>
        {(list) =>
          list.length ? (
            <Table
              data={list.map((i) => ({ ...i }))}
              idKey="id"
              columns={[
                { key: "role", header: t("ws.role"), renderCell: (i) => t(`role.${i.role}`) },
                { key: "createdAt", header: t("ws.createdAt"), renderCell: (i) => <Timestamp value={i.createdAt} format="date_time" /> },
                { key: "expiresAt", header: t("ws.expires"), renderCell: (i) => <Timestamp value={i.expiresAt} format="date_time" /> },
                {
                  key: "actions",
                  header: "",
                  align: "end",
                  renderCell: (i) =>
                    can(myRole, "revokeInvite") && roles.includes(i.role) ? (
                      <Button label={t("common.revoke")} variant="destructive" size="sm" clickAction={() => revoke(i)} />
                    ) : null,
                },
              ]}
            />
          ) : (
            <Empty text={t("ws.noInvites")} />
          )
        }
      </Loaded>
      <FormDialog isOpen={inviting} onClose={close}>
        <CreateInvite base={base} roles={roles} onClose={close} onCreated={reload} />
      </FormDialog>
    </Panel>
  );
}

function CreateWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { t, refreshMe } = useApp();
  const notify = useNotify();
  const [name, setName] = useState("");
  const create = async () => {
    let r: { workspace: { id: string } };
    try {
      r = await api(`/v1/workspaces`, { body: { name: name.trim() } });
    } catch (e) {
      if (e instanceof ApiError && e.code === "forbidden") throw new Error(t("ws.createForbidden"));
      throw e;
    }
    notify.ok(t("ws.created"));
    await refreshMe();
    await onCreated(r.workspace.id);
  };
  return (
    <DialogForm title={t("ws.create")} submitLabel={t("ws.createButton")} canSubmit={name.trim() !== ""} onSubmit={create} onClose={onClose}>
      <TextInput label={t("ws.name")} placeholder={t("ws.namePlaceholder")} value={name} onChange={setName} isRequired />
    </DialogForm>
  );
}
