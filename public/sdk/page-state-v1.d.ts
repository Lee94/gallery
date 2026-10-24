export {};

declare global {
  interface GalleryCapabilities {
    protocolVersion: number;
    pageState: boolean;
    visitorState: boolean;
    kv: boolean;
    attachments: boolean;
    llm: boolean;
    dataGeneration: number;
    dataSchemaVersion: number;
  }

  type GalleryEventType = "page-state" | "kv" | "comments" | "version" | "attachments" | "reset";

  interface GalleryEvent {
    id: number;
    type: GalleryEventType;
    createdAt?: number;
    collection?: string;
    key?: string;
    version?: number;
    versionNo?: number;
    dataGeneration?: number;
    dataSchemaVersion?: number;
  }

  interface GalleryEventsNamespace {
    subscribe(
      listener: (event: GalleryEvent) => void,
      options?: { types?: GalleryEventType[] },
    ): Promise<() => Promise<{ unsubscribed: boolean }>>;
  }

  interface GallerySnapshot<T = unknown> {
    data: T;
    version: number;
    updatedAt: number;
  }

  interface GalleryStateError extends Error {
    code: string;
    status: number;
    snapshot?: GallerySnapshot;
    result?: unknown;
  }

  interface GalleryStateErrorConstructor {
    new (
      message: string,
      options: {
        code: string;
        status?: number;
        snapshot?: GallerySnapshot;
        result?: unknown;
      },
    ): GalleryStateError;
  }

  interface GalleryStateStore<T = unknown> {
    get(): Promise<GallerySnapshot<T>>;
    save(data: T, baseVersion: number): Promise<GallerySnapshot<T>>;
    update(
      updater: (data: T) => T | Promise<T>,
      options?: { maxAttempts?: number },
    ): Promise<GallerySnapshot<T>>;
  }

  interface GalleryStateNamespace {
    connect<T = unknown>(): GalleryStateStore<T>;
    Error: GalleryStateErrorConstructor;
    protocolVersion: number;
  }

  interface GalleryKvItem<T = unknown> {
    collection: string;
    key: string;
    value: T;
    version: number;
    sizeBytes: number;
    createdAt: number;
    updatedAt: number;
  }

  interface GalleryKvCollection {
    get<T = unknown>(key: string): Promise<GalleryKvItem<T> | null>;
    list<T = unknown>(options?: {
      prefix?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{ items: Array<GalleryKvItem<T>>; nextCursor: string | null }>;
    put<T = unknown>(
      key: string | undefined,
      value: T,
      options?: { baseVersion?: number; ifAbsent?: boolean },
    ): Promise<GalleryKvItem<T>>;
    del(
      key: string,
      options?: { baseVersion?: number },
    ): Promise<{ deleted: boolean }>;
    update<T = unknown>(
      key: string,
      updater: (value: T | null, item: GalleryKvItem<T> | null) => T | Promise<T>,
      options?: { maxAttempts?: number },
    ): Promise<GalleryKvItem<T>>;
  }

  interface GalleryDbNamespace {
    collection(name: string): GalleryKvCollection;
    Error: GalleryStateErrorConstructor;
    protocolVersion: number;
  }

  interface GalleryAttachment {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    visibility: "private" | "shared";
    isMine: boolean;
    createdAt: number;
  }

  interface GalleryFilesNamespace {
    list(): Promise<{ items: GalleryAttachment[] }>;
    upload(
      file: Blob,
      options?: { name?: string; visibility?: "private" | "shared" },
    ): Promise<GalleryAttachment>;
    download(attachmentId: string): Promise<Blob>;
    delete(attachmentId: string): Promise<{ deleted: boolean }>;
  }

  interface GalleryLlmToolCall {
    id: string;
    name: string;
    arguments: unknown;
    rawArguments: string;
  }

  interface GalleryLlmMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolCalls?: GalleryLlmToolCall[];
  }

  interface GalleryLlmTool<T = unknown, R = unknown> {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      args: T,
      context: { signal?: AbortSignal; id: string; name: string },
    ): R | Promise<R>;
  }

  interface GalleryLlmResult {
    text?: string;
    model?: string;
    usage?: Record<string, number>;
    finishReason?: string | null;
    toolCalls?: GalleryLlmToolCall[];
    json?: unknown;
  }

  interface GalleryLlmNamespace {
    chat(options: {
      prompt?: string;
      messages?: GalleryLlmMessage[];
      context?: string;
      responseSchema?: Record<string, unknown>;
      tools?: GalleryLlmTool[];
      onDelta?: (delta: string) => void;
      signal?: AbortSignal;
      retries?: number;
    }): Promise<GalleryLlmResult>;
    ask(prompt: string, options?: { context?: string }): Promise<GalleryLlmResult>;
    Error: GalleryStateErrorConstructor;
    protocolVersion: number;
  }

  interface GalleryApi {
    getCapabilities(): Promise<GalleryCapabilities>;
    requireDataSchema(version: number): number;
    events: GalleryEventsNamespace;
    pageState: GalleryStateNamespace;
    visitorState: GalleryStateNamespace;
    db: GalleryDbNamespace;
    files: GalleryFilesNamespace;
    llm: GalleryLlmNamespace;
    Error: GalleryStateErrorConstructor;
    protocolVersion: number;
  }

  const Gallery: GalleryApi;
  const GalleryPageState: GalleryStateNamespace;
  const GalleryVisitorState: GalleryStateNamespace;
  const GalleryDB: GalleryDbNamespace;
  const GalleryLLM: GalleryLlmNamespace;

  interface Window {
    Gallery: GalleryApi;
    GalleryPageState: GalleryStateNamespace;
    GalleryVisitorState: GalleryStateNamespace;
    GalleryDB: GalleryDbNamespace;
    GalleryLLM: GalleryLlmNamespace;
  }
}
