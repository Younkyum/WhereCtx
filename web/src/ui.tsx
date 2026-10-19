/**
 * Shared building blocks for the screens: data loading with its three states,
 * actions that report failures as toasts, the confirm dialog, the dialog every
 * create or edit form opens in, page and panel headings, one-time secrets and
 * recovery codes.
 */

import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, Layout, LayoutContent, LayoutFooter, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Fragment, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, isHandled } from "./api";
import { useApp } from "./context";
import type { Lang, Translate } from "./i18n";
import { ageParts, bearerHeader, errorKey, passkeyErrorKey } from "./lib";

/** A message the person can act on, for any error an action or loader throws. */
export function describe(e: unknown, t: Translate): string {
  const passkey = passkeyErrorKey(e);
  if (passkey) return t(passkey);
  if (e instanceof ApiError) {
    const key = errorKey(e);
    return key ? t(key) : e.message;
  }
  return e instanceof Error && e.message ? e.message : t("err.generic");
}

export function useNotify() {
  const toast = useToast();
  const { t } = useApp();
  return {
    ok: (body: string) => {
      toast({ body });
    },
    fail: (e: unknown) => {
      if (!isHandled(e)) toast({ body: describe(e, t), type: "error" });
    },
  };
}

/** Runs fn once at a time; a failure becomes an error toast. */
export function useAction(fn: () => Promise<void> | void): [busy: boolean, run: () => Promise<void>] {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify.fail(e);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return [busy, run];
}

export type Load<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: T };

/**
 * Loads data for a view and reloads on demand. A reload keeps showing the old
 * data until the new arrives. A lost session leaves the state alone: the app
 * is already on its way back to sign-in.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]): [Load<T>, () => Promise<void>] {
  const { t } = useApp();
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const latest = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(async () => {
    const id = ++latest.current;
    try {
      const data = await loaderRef.current();
      if (id === latest.current) setState({ kind: "ready", data });
    } catch (e) {
      if (id === latest.current && !isHandled(e)) setState({ kind: "error", message: describe(e, t) });
    }
  }, [t]);
  useEffect(() => {
    setState({ kind: "loading" });
    void reload();
    return () => {
      latest.current++;
    };
  }, deps);
  return [state, reload];
}

/**
 * A newest-first log read page by page through its `next` cursor. `more`
 * appends the following page; changing `url` (or reloading) starts over, and
 * a page asked for before that is dropped when it arrives.
 */
export function usePaged<T>(url: string): {
  state: Load<T[]>;
  hasMore: boolean;
  loadingMore: boolean;
  more: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const next = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const [extra, setExtra] = useState<T[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const page = (before?: string) => {
    const sep = url.includes("?") ? "&" : "?";
    return api<{ entries: T[]; next?: string }>(before ? `${url}${sep}before=${encodeURIComponent(before)}` : url);
  };
  const [state, reload] = useLoad(async () => {
    const asked = ++generation.current;
    next.current = undefined;
    const first = await page();
    if (asked === generation.current) {
      next.current = first.next;
      setExtra([]);
      setHasMore(Boolean(first.next));
    }
    return first.entries ?? [];
  }, [url]);
  const [loadingMore, more] = useAction(async () => {
    const asked = generation.current;
    if (!next.current) return;
    const following = await page(next.current);
    if (asked !== generation.current) return;
    next.current = following.next;
    setExtra((rows) => [...rows, ...(following.entries ?? [])]);
    setHasMore(Boolean(following.next));
  });
  const merged: Load<T[]> = state.kind === "ready" ? { kind: "ready", data: [...state.data, ...extra] } : state;
  return { state: merged, hasMore, loadingMore, more, reload };
}

export function Loaded<T>({ state, children }: { state: Load<T>; children: (data: T) => ReactNode }) {
  const { t } = useApp();
  if (state.kind === "loading") return <Spinner label={t("common.loading")} />;
  if (state.kind === "error") return <Banner status="error" title={state.message} />;
  return <>{children(state.data)}</>;
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <VStack gap={1}>
      <Heading level={1}>{title}</Heading>
      {description ? <Text type="body" color="secondary">{description}</Text> : null}
    </VStack>
  );
}

export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Section>
      <VStack gap={4}>
        <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={2}>{title}</Heading>
          {actions}
        </HStack>
        {children}
      </VStack>
    </Section>
  );
}

export function Page({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <VStack gap={6}>
      <PageHeader title={title} description={description} />
      {children}
    </VStack>
  );
}

export function Empty({ text }: { text: string }) {
  return <EmptyState title={text} isCompact headingLevel={3} />;
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <Text type="supporting" display="block">
      {children}
    </Text>
  );
}

/**
 * One record in a list: its name and details, with controls that wrap below
 * on a phone. A string subtitle is set as supporting text; anything else is
 * placed as given.
 */
export function Row({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <HStack gap={3} vAlign="center" wrap="wrap" paddingBlock={3}>
      <StackItem size="fill">
        <VStack gap={0.5}>
          <Text weight="semibold">{title}</Text>
          {typeof subtitle === "string" ? <Text type="supporting">{subtitle}</Text> : subtitle}
        </VStack>
      </StackItem>
      {children ? (
        <HStack gap={2} vAlign="center" wrap="wrap">
          {children}
        </HStack>
      ) : null}
    </HStack>
  );
}

export function Rows<T>({ items, keyOf, children }: { items: T[]; keyOf: (item: T) => string; children: (item: T) => ReactNode }) {
  return (
    <VStack gap={0}>
      {items.map((item, i) => (
        <Fragment key={keyOf(item)}>
          {i > 0 ? <Divider /> : null}
          {children(item)}
        </Fragment>
      ))}
    </VStack>
  );
}

/** A value shown once (a token, a link, a config) with the copy button CodeBlock provides. */
export function Secret({ label, value, language = "plaintext" }: { label: string; value: string; language?: string }) {
  return <CodeBlock code={value} title={label} language={language} isWrapped width="100%" hasLanguageLabel={false} />;
}

/**
 * An HTTP header to type into another app, as two labelled fields: the name,
 * and the value with its "Bearer " prefix set apart so it is not left out.
 * The value's copy button copies the whole thing, prefix included.
 */
export function BearerHeader({ token, hint }: { token: string; hint: string }) {
  const { t } = useApp();
  const header = bearerHeader(token);
  return (
    <VStack gap={3} data-testid="bearer-header">
      <Secret label={t("header.name")} value={header.name} />
      <VStack gap={1}>
        <HStack gap={1} vAlign="center" wrap="wrap" aria-hidden>
          <Badge variant="purple" label="Bearer" />
          <Text type="supporting">{t("header.space")}</Text>
          <Text type="supporting">{t("header.token")}</Text>
        </HStack>
        <Secret label={t("header.value")} value={header.value} />
      </VStack>
      <Hint>{hint}</Hint>
    </VStack>
  );
}

export function download(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Recovery codes, shown once: copy, download, and a confirmation before continuing. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useApp();
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");
  return (
    <VStack gap={4}>
      <CodeBlock code={text} language="plaintext" width="100%" hasLanguageLabel={false} title={t("codes.title")} />
      <HStack gap={2} wrap="wrap">
        <Button label={t("codes.download")} onClick={() => download("wherectx-recovery-codes.txt", text + "\n", "text/plain")} />
      </HStack>
      <CheckboxInput label={t("codes.saved")} value={saved} onChange={setSaved} />
      <Button label={t("codes.continue")} variant="primary" isDisabled={!saved} onClick={onDone} width="100%" />
    </VStack>
  );
}

export interface ConfirmRequest {
  title: string;
  description?: string;
  action: string;
  isDestructive?: boolean;
}

type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useApp();
  const [pending, setPending] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);
  // Opened from a macrotask: a Button's clickAction runs in a React transition,
  // which would hold this update until the action ends, and the action is
  // waiting for this dialog.
  const confirm = useCallback<Confirm>(
    (request) => new Promise((resolve) => setTimeout(() => setPending({ ...request, resolve }))),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) settle(false);
          }}
          title={pending.title}
          description={pending.description ?? t("common.cannotUndo")}
          actionLabel={pending.action}
          actionVariant={pending.isDestructive === false ? "primary" : "destructive"}
          cancelLabel={t("common.cancel")}
          onAction={() => settle(true)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

/**
 * Set while a DialogForm's submit runs, or while a DialogResult must be read
 * to the end, so its FormDialog ignores Escape until then.
 */
const SubmittingContext = createContext<{ current: boolean } | null>(null);

/**
 * The lightbox a create or edit form opens in. Its body mounts only while
 * open, so Cancel, Escape and the close button all discard the draft.
 */
export function FormDialog({ isOpen, onClose, children }: { isOpen: boolean; onClose: () => void; children: ReactNode }) {
  const submitting = useRef(false);
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
      purpose="form"
      width={600}
    >
      <SubmittingContext.Provider value={submitting}>{isOpen ? children : null}</SubmittingContext.Provider>
    </Dialog>
  );
}

/** A refused submit as a localized title over the server's own words, which are often English. */
function failureText(e: unknown, t: Translate): { title: string; detail: string } {
  if (e instanceof ApiError) {
    const key = errorKey(e);
    return { title: t(key ?? "err.generic"), detail: [...(key ? [] : [e.message]), ...e.detail].join("; ") };
  }
  return { title: t("err.generic"), detail: e instanceof Error ? e.message : "" };
}

/**
 * A FormDialog's content: title, fields, Cancel and submit. A submit that
 * succeeds closes the dialog, unless `keepOpen` says its result shows next;
 * one that fails keeps it open with the server's answer under the fields.
 * While it runs, nothing closes the dialog.
 */
export function DialogForm({
  title,
  subtitle,
  submitLabel,
  canSubmit,
  keepOpen = false,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  submitLabel: string;
  canSubmit: boolean;
  keepOpen?: boolean;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useApp();
  const formId = useId();
  const ownRunning = useRef(false);
  const running = useContext(SubmittingContext) ?? ownRunning;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  // A submit can swap this form for its result before it returns; the
  // unmount releases the hold so the result can take it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      running.current = false;
    };
  }, [running]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit();
    } catch (err) {
      running.current = false;
      setBusy(false);
      if (!isHandled(err)) setFailure(err);
      return;
    }
    if (mounted.current) {
      running.current = false;
      setBusy(false);
    }
    if (!keepOpen) onClose();
  };
  const close = () => {
    if (!running.current) onClose();
  };
  const shown = failure ? failureText(failure, t) : null;
  return (
    <Layout
      header={
        <DialogHeader
          title={title}
          subtitle={subtitle}
          onOpenChange={(open) => {
            if (!open) close();
          }}
        />
      }
      content={
        <LayoutContent>
          <form id={formId} onSubmit={submit}>
            <VStack gap={4}>{children}</VStack>
          </form>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <VStack gap={3}>
            {shown ? <Banner status="error" title={shown.title} description={shown.detail || undefined} /> : null}
            <HStack gap={2} hAlign="end" wrap="wrap">
              <Button label={t("common.cancel")} onClick={close} isDisabled={busy} />
              <Button type="submit" form={formId} label={submitLabel} variant="primary" isLoading={busy} isDisabled={!canSubmit} />
            </HStack>
          </VStack>
        </LayoutFooter>
      }
    />
  );
}

/**
 * What a FormDialog shows once its form succeeded: a one-time secret, a link,
 * setup steps. Done closes it. With `mustConfirm`, only the content's own
 * button closes it, so recovery codes are not dismissed unread.
 */
export function DialogResult({
  title,
  subtitle,
  mustConfirm = false,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  mustConfirm?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useApp();
  const held = useContext(SubmittingContext);
  useEffect(() => {
    if (!mustConfirm || !held) return;
    held.current = true;
    return () => {
      held.current = false;
    };
  }, [mustConfirm, held]);
  return (
    <Layout
      header={
        <DialogHeader
          title={title}
          subtitle={subtitle}
          onOpenChange={
            mustConfirm
              ? undefined
              : (open) => {
                  if (!open) onClose();
                }
          }
        />
      }
      content={
        <LayoutContent>
          <VStack gap={4}>{children}</VStack>
        </LayoutContent>
      }
      footer={
        mustConfirm ? undefined : (
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label={t("common.done")} variant="primary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        )
      }
    />
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm outside <ConfirmProvider>");
  return confirm;
}

const locale = (lang: Lang) => (lang === "ko" ? "ko-KR" : "en-US");

/** Date and age formatting in the page's language, for times inside sentences. */
export function useFormat() {
  const { lang, t } = useApp();
  const time = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(locale(lang), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  return {
    time,
    date(iso: string): string {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleDateString(locale(lang), { year: "numeric", month: "short", day: "numeric" });
    },
    /** "12 min ago" within a day; past that, the date and time it was. */
    ago(min: number): string {
      const parts = ageParts(min);
      if (parts) return t(parts[0], { n: parts[1] });
      return time(new Date(Date.now() - Math.max(0, Number(min) || 0) * 60_000).toISOString());
    },
  };
}
