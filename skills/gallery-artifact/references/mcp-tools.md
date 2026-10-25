# Gallery MCP Tool Reference

Tools are exposed by the Gallery MCP server (names prefixed `mcp__gallery__` in
Claude Code). All operate on the current token owner's shares only. `slug` is the
segment in `/s/<slug>`.

**CLI equivalent:** without MCP, run `gallery call <tool> '<json-args>'` (or
`node cli/gallery.mjs call …`) with `GALLERY_URL`/`GALLERY_TOKEN` set. Arguments
are the same JSON object; results and errors are JSON on stdout/stderr.
`gallery tools` prints this same list with input schemas.

## Publishing and files

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `upload_file` | Create a share, returns `slug` + `url` | `filename`, `content`, `encoding` (`utf8`/`base64`), `runtime` (`static`/`react`), `password?`, `expiresIn?`, `pageStateEnabled`, `visitorStateEnabled`, `kvEnabled`, `commentsEnabled`, `attachmentsEnabled`, `llmEnabled`, `llmModel?`, `llmDailyTokenBudget?` |
| `list_shares` | List own shares with links, type, size, password/expiry | — |
| `list_share_files` | List files of a multi-file artifact | `slug` |
| `update_share_file` | Replace one file's content | `slug`, `path`, `content`, `encoding` |
| `upload_share_files` | Batch upload/update (all validated before any write) | `slug`, `files[]` (≤255), `entryPath?` |
| `delete_share_file` | Remove a file | `slug`, `path` |
| `delete_share` | Delete the share and its data | `slug` |
| `fork_share` | Copy files + capability config into a new share | `slug` |
| `update_share_metadata` | Title, description, emoji icon, OG cover, public source | `slug`, `title`, `description`, `icon`, `coverPath`, `sourceEnabled` |
| `set_share_pinned`, `move_share` | Organize the owner's file list | `slug`, `pinned` / `direction` (-1/1) |

## Access control

| Tool | Purpose |
| --- | --- |
| `set_password` / `remove_password` | Set/change (invalidates existing visitor tokens) or remove the share password |
| `set_expiry` | `expiresIn` duration (`7d`) or `never` |

## Capabilities and data

| Tool | Purpose |
| --- | --- |
| `set_page_state_enabled`, `reset_page_state` | Toggle shared page JSON (disable keeps data); clear it |
| `set_visitor_state_enabled`, `reset_visitor_state` | Toggle per-visitor JSON; clear it |
| `set_kv_enabled` | Toggle KV collections |
| `set_kv_policy` | Per-collection ACL: `readMode` all/owner, `writeMode`/`deleteMode` all/owner/creator. Default is all/all/all |
| `kv_list`, `kv_get`, `kv_put`, `kv_delete` | Owner-side row access; `kv_put` supports `baseVersion` and `ifAbsent` |
| `kv_clear_collection` | Owner-only destructive clear of one collection |
| `set_data_schema_version` | Set the `dataSchemaVersion` pages must declare |
| `reset_data_space` | **Destructive**: wipe page/visitor/KV data, increment `dataGeneration` |
| `set_attachments_enabled` | Toggle visitor attachments |

## Versions, comments, LLM

| Tool | Purpose |
| --- | --- |
| `list_versions`, `publish_version`, `rollback_to_version` | Inspect and restore snapshots |
| `set_comments_enabled`, `set_comments_visitor_write` | Comment panel and visitor posting |
| `list_comments`, `reply_comment`, `set_comment_status` | Read, reply, moderate |
| `ban_visitor`, `unban_visitor` | Moderate visitors |
| `set_llm_enabled` | Toggle LLM, override model and daily token budget |
| `llm_usage` | Inspect token usage |

## Limits to remember

- Upload size: `MAX_FILE_SIZE_MB` (default 50 MB) per file.
- Shared page JSON: latest snapshot only, default 256 KB.
- KV: collection `[a-zA-Z0-9_-]{1,64}`, key ≤256 chars, no `/` or `\`.
- Attachments: default 10 MB/file, 100 MB/share, 20 MB/visitor.
- LLM: at most 2 active calls per share, 1 per visitor; daily token budget per
  share (default 50000).
- Rate limits, SSE, and LLM reservations are in-process: single-instance
  deployments only.
