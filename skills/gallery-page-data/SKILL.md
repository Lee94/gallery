---
name: gallery-page-data
description: Use the Gallery page SDK for persistence and realtime in HTML/React artifacts — shared page JSON (Gallery.pageState), per-visitor state (Gallery.visitorState), KV collections with ACLs (Gallery.db), SSE change events (Gallery.events), data schema versioning, and visitor attachments (Gallery.files). Load whenever an artifact stores, syncs, or uploads data.
---

# Gallery Page Data

Include the SDK once, then use the unified `window.Gallery` namespace:

```html
<script src="/sdk/page-state-v1.js"></script>
```

Legacy globals `GalleryPageState`, `GalleryVisitorState`, `GalleryDB`, `GalleryLLM`
still work; new code uses `Gallery.*`. All APIs are async and return promises.
Types: `/sdk/page-state-v1.d.ts`. The SDK connects only on the `/s/<slug>`
preview page — raw URLs and version previews have no live data.

## Start every stateful artifact the same way

```js
const caps = await Gallery.getCapabilities();
// caps: { pageState, visitorState, kv, attachments, llm,
//         dataGeneration, dataSchemaVersion, protocolVersion }
if (!caps.pageState) { /* show read-only/disabled UI, don't throw blindly */ }
```

Enable each capability at upload (`pageStateEnabled`, `visitorStateEnabled`,
`kvEnabled`, `attachmentsEnabled`) or later via MCP/dashboard. `dataGeneration`
changes when the owner resets the data space; stale writes are then rejected —
surface that instead of retrying forever.

For breaking data-shape changes, call `Gallery.requireDataSchema(version)` once
at startup and have the owner set the same version with
`set_data_schema_version`; mismatched reads/writes fail with 409.

## Choosing a store

| Need | Use | Notes |
| --- | --- | --- |
| One shared document for the whole page (todo list, board, poll) | `Gallery.pageState` | Latest snapshot only, default 256 KB; every visitor with access can write |
| Per-visitor private JSON (drafts, settings, progress) | `Gallery.visitorState` | Anonymous visitors get a random device identity held by the parent page; signed-in users are consistent across devices |
| Many independent rows, concurrent writers, permissions | `Gallery.db` collections | Row-level CAS and collection ACLs |
| Binary/user files | `Gallery.files` | Private or shared attachments |

Do **not** use browser storage — the sandbox has an opaque origin.

## pageState / visitorState

```js
const store = Gallery.pageState.connect();   // or Gallery.visitorState.connect()
const snap = await store.get();              // { data, version, updatedAt }
await store.save(data, snap.version);        // conditional write, conflicts on stale baseVersion
await store.update((data) => ({ ...shape(data) }), { maxAttempts: 5 });
```

Prefer `update`: it re-reads and retries compare-and-swap automatically. The
updater must be pure-ish and return a **new JSON-serializable** object — it may
run several times. Initialize from `null`/empty data on first run.

## KV collections

```js
const todos = Gallery.db.collection("todos");
await todos.put(crypto.randomUUID(), { text, done: false }, { ifAbsent: true });
const row = await todos.get(key);            // GalleryKvItem | null
const page = await todos.list({ prefix: "2026-", limit: 100 }); // { items, nextCursor }
await todos.update(key, (value) => ({ ...value, done: true }));
await todos.del(key, { baseVersion: row.version });
```

- Collection names `[a-zA-Z0-9_-]{1,64}`; keys ≤256 chars, no `/`, `\`, or
  control characters.
- Default ACL is all/all/all. For owner-only collections the owner sets
  `set_kv_policy` (`readMode` all/owner; `writeMode`/`deleteMode`
  all/owner/creator). Design the UI for 403s: hide or disable actions the current
  visitor cannot perform, and never rely on client-side hiding as enforcement.
- Rows are `{ collection, key, value, version, sizeBytes, createdAt, updatedAt }`.
  Use `version` for conditional writes; never leak `creatorKey` (or any identity
  token) into values you render for other visitors.

## Realtime

```js
const unsubscribe = await Gallery.events.subscribe(
  (event) => { /* event: { id, type, collection?, key?, version?, ... } */ },
  { types: ["page-state", "kv", "comments", "version", "attachments"] },
);
```

Events are **change hints, not payloads** — re-read through the matching API.
Coalesce bursts (e.g. one in-flight refresh per store) instead of fetching per
event. SSE supports replay/heartbeat; on a `reset` event or a `dataGeneration`
change, reload all state. Call the returned unsubscribe function on teardown.

## Attachments

```js
const file = await Gallery.files.upload(blob, { name: "photo.png", visibility: "shared" });
const { items } = await Gallery.files.list();
const blob2 = await Gallery.files.download(file.id);
await Gallery.files.delete(file.id);
```

`private` = uploader + owner only; `shared` = anyone with share access. Downloads
are forced attachments with `nosniff` — create object URLs to preview images, do
not hotlink them as page assets. Respect quotas (default 10 MB/file,
20 MB/visitor, 100 MB/share) and handle 413/403 in the UI.

## Security posture

Shared data on a public link is public and writable by visitors. Validate and
sanitize everything you read before rendering (use `textContent`, not
`innerHTML`, for stored strings), bound the sizes you accept, and never store
secrets or personal data in pageState/KV/attachments.
