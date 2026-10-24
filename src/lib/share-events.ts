// 单实例进程内事件总线：与现有限流器一样，以单容器部署为前提。
// SSE 只发送变更提示（collection/key/version 等），不发送页面数据、评论正文或访客私有内容。
export const SHARE_EVENT_TYPES = ["page-state", "kv", "comments", "version", "attachments"] as const;
export type ShareEventType = (typeof SHARE_EVENT_TYPES)[number];

export interface ShareEvent {
  id: number;
  type: ShareEventType;
  createdAt: number;
  collection?: string;
  key?: string;
  version?: number;
  versionNo?: number;
  dataGeneration?: number;
  dataSchemaVersion?: number;
}

type Listener = (event: ShareEvent) => void;

type Channel = {
  events: ShareEvent[];
  listeners: Set<Listener>;
};

type EventHub = {
  sequence: number;
  channels: Map<string, Channel>;
};

const MAX_REPLAY_EVENTS = 200;
const globalForEvents = globalThis as unknown as { __galleryEventHub?: EventHub };

function hub(): EventHub {
  return (globalForEvents.__galleryEventHub ??= { sequence: 0, channels: new Map() });
}

function channelFor(shareId: string): Channel {
  const h = hub();
  let channel = h.channels.get(shareId);
  if (!channel) {
    channel = { events: [], listeners: new Set() };
    h.channels.set(shareId, channel);
  }
  return channel;
}

export function publishShareEvent(
  shareId: string,
  type: ShareEventType,
  detail: Partial<
    Pick<
      ShareEvent,
      "collection" | "key" | "version" | "versionNo" | "dataGeneration" | "dataSchemaVersion"
    >
  > = {},
): ShareEvent {
  const h = hub();
  const event: ShareEvent = {
    id: ++h.sequence,
    type,
    createdAt: Date.now(),
    ...detail,
  };
  const channel = channelFor(shareId);
  channel.events.push(event);
  if (channel.events.length > MAX_REPLAY_EVENTS) channel.events.shift();
  for (const listener of channel.listeners) listener(event);
  return event;
}

export function subscribeShareEvents(shareId: string, listener: Listener): () => void {
  const channel = channelFor(shareId);
  channel.listeners.add(listener);
  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size === 0 && channel.events.length === 0) {
      hub().channels.delete(shareId);
    }
  };
}

export function currentShareEventId(): number {
  return hub().sequence;
}

export function replayShareEvents(
  shareId: string,
  afterId: number,
): { events: ShareEvent[]; reset: boolean; currentId: number } {
  const h = hub();
  const events = h.channels.get(shareId)?.events ?? [];
  const oldestId = events[0]?.id;
  const reset =
    afterId > h.sequence || (oldestId !== undefined && afterId < oldestId - 1);
  return {
    events: reset ? [] : events.filter((event) => event.id > afterId),
    reset,
    currentId: h.sequence,
  };
}
