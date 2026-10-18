/**
 * The server's recent log, for the operator only (the instance owner). The
 * server redacts every entry before keeping it and never keeps the boot
 * banners, so no secret or location shows here.
 */

import { Badge, type BadgeProps } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { LOG_LEVELS, oneOf, type LogEntry, type LogLevel } from "../model";
import { Empty, Hint, Loaded, Page, Panel, Row, Rows, useFormat, useLoad } from "../ui";

const LEVEL_BADGE: Record<LogLevel, BadgeProps["variant"]> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "error",
};

const FILTERS = ["info", "warn", "error"] as const satisfies readonly LogLevel[];

export function ServerLogsView() {
  const { t } = useApp();
  const format = useFormat();
  const [level, setLevel] = useState<LogLevel>("info");
  const [state, reload] = useLoad(
    () => api<{ entries: LogEntry[] }>(`/v1/admin/logs?level=${level}&limit=200`).then((r) => r.entries ?? []),
    [level],
  );
  return (
    <Page title={t("logs.title")} description={t("logs.desc")}>
      <Panel title={t("logs.recent")} actions={<Button label={t("devices.refresh")} size="sm" onClick={() => void reload()} />}>
        <VStack gap={3}>
          <SegmentedControl label={t("logs.level")} value={level} onChange={(v) => oneOf(LOG_LEVELS, v) && setLevel(v)}>
            {FILTERS.map((l) => (
              <SegmentedControlItem key={l} value={l} label={t(`logs.filter.${l}`)} />
            ))}
          </SegmentedControl>
          <Loaded state={state}>
            {(entries) =>
              entries.length ? (
                <Rows items={entries.map((e, i) => ({ ...e, key: `${e.time}-${i}` }))} keyOf={(e) => e.key}>
                  {(e) => (
                    <Row
                      title={
                        <HStack gap={2} wrap="wrap" vAlign="center">
                          <Badge variant={LEVEL_BADGE[e.level] ?? "neutral"} label={t(`logs.level.${e.level}`)} />
                          <Text weight="semibold" wordBreak="break-word">
                            {e.msg}
                          </Text>
                        </HStack>
                      }
                      subtitle={
                        <VStack gap={1}>
                          <Text type="supporting">{format.time(e.time)}</Text>
                          {e.fields
                            ? Object.entries(e.fields).map(([k, v]) => (
                                <Code key={k}>{`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`}</Code>
                              ))
                            : null}
                        </VStack>
                      }
                    />
                  )}
                </Rows>
              ) : (
                <Empty text={t("logs.empty")} />
              )
            }
          </Loaded>
          <Hint>{t("logs.note")}</Hint>
        </VStack>
      </Panel>
    </Page>
  );
}
