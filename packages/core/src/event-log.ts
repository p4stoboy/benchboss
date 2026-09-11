import type { LogEvent } from "./types";

export function appendEvent(
  events: readonly LogEvent[],
  e: Omit<LogEvent, "seq">,
): readonly LogEvent[] {
  return [...events, { ...e, seq: events.length }];
}

export function eventsToJsonl(events: readonly LogEvent[]): string {
  return `${events.map((ev) => JSON.stringify(ev)).join("\n")}\n`;
}

export function parseJsonl(text: string): LogEvent[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogEvent);
}
