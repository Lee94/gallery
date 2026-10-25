---
name: gallery-artifact
description: Publish and manage artifacts on Gallery (self-hosted file sharing). Use whenever the user asks to create, upload, share, update, fork, or delete an HTML page, React app, document, image, or other file and get a /s/<slug> link. Entry point for all Gallery MCP work; routes to the design, data, LLM, and React skills.
---

# Gallery Artifacts

Gallery turns a file into a share link `/s/<slug>` with optional password and
expiry. HTML artifacts can also be small apps: shared JSON state, per-visitor
state, KV collections, attachments, comments, and a server-side LLM.

## Execution backend: MCP first, CLI fallback

Prefer the Gallery MCP tools (`mcp__gallery__*`). When MCP is not connected but
a shell is available, use the Gallery CLI (`cli/gallery.mjs` in the Gallery
repository, or `gallery` on PATH) with `GALLERY_URL`/`GALLERY_TOKEN` set:

- `gallery call <tool> '<json-args>'` is the exact equivalent of the MCP tool of
  the same name — every tool and argument in this skill set works unchanged.
- `gallery tools` lists tool names and input schemas when you are unsure.
- Convenience commands cover the common flows: `gallery upload <file>`,
  `gallery upload --dir <dir> --entry index.html`, `gallery ls`, `gallery files
  <slug>`, `gallery put-file`, `gallery put-files`, `gallery kv …`,
  `gallery versions`, `gallery rollback`.
- Output contract: success = result JSON on stdout, exit 0; failure = JSON error
  on stderr, non-zero exit. Parse stdout, do not scrape human text.
- Never invent a token or ask for server secrets; if neither MCP nor CLI
  credentials are available, tell the user to create a token at
  `/settings/tokens` instead of falling back to undocumented endpoints.

## Pick the right path first

1. **Static HTML** (default): one self-contained `.html` file, or a multi-file
   artifact with an HTML entry and relative assets. Best for reports, dashboards,
   tools, games, visualizations.
2. **React runtime**: entry is `.jsx`/`.tsx`, built server-side with a pinned
   React. Load `gallery-react-artifact` before writing any code.
3. **Non-HTML files**: PDF, images, Markdown, text — upload as-is; no page SDK.

Before writing HTML, load `gallery-artifact-design`. If the artifact needs
persistence, realtime, or attachments, load `gallery-page-data`; if it calls an
LLM, load `gallery-page-llm`. Do this **before** uploading, because capabilities
are enabled at upload time.

## Publish workflow

1. Decide the capabilities the page actually uses — `pageStateEnabled`,
   `visitorStateEnabled`, `kvEnabled`, `attachmentsEnabled`, `commentsEnabled`,
   `llmEnabled` (plus optional `llmModel`, `llmDailyTokenBudget`). All are off by
   default and only meaningful for HTML/React artifacts.
2. Upload with `upload_file`: `filename` (the extension drives rendering),
   `content`, `encoding` (`base64` for binary), `runtime`, and the capability
   flags. Optional `password`, `expiresIn` (`30m`, `12h`, `7d`, `2w`).
3. Return the `/s/<slug>` URL from the tool result. Keep the `slug` — every later
   operation needs it.
4. For a multi-file artifact, follow up with `upload_share_files`
   (`files: [{path, content, encoding?}]`, optional `entryPath`). Paths are
   relative, server-validated; the entry must exist after the batch.
5. Optionally set presentation with `update_share_metadata` (`title`,
   `description`, `icon`, `coverPath`, `sourceEnabled`).

## Update workflow

- Read first when editing someone else's existing artifact: `list_share_files`,
  then change only what is needed via `update_share_file` or `upload_share_files`.
- Every successful write creates a version snapshot. Use `list_versions`,
  `publish_version`, `rollback_to_version` for history; do not re-upload a new
  share just to change content.
- Structural data changes: coordinate `set_data_schema_version` with the page's
  `Gallery.requireDataSchema()`. `reset_data_space` wipes page/visitor/KV data
  permanently — confirm with the user before calling it, same for `delete_share`
  and `kv_clear_collection`.

## Rules that are not optional

- All tools act only on the token owner's own shares. A missing/expired share is
  a 404 by design; never treat that as permission to probe other slugs.
- The page SDK works **only** on the `/s/<slug>` preview page — not on raw file
  URLs, not on historical version previews.
- Never ask the user for the server's `LLM_API_KEY` or other secrets; the LLM
  proxy is server-side. Public shares are not secret storage: anyone with the
  link (and password, if set) can read shared data.
- Enabling a capability does not require rebuilding the artifact:
  `set_page_state_enabled`, `set_visitor_state_enabled`, `set_kv_enabled`,
  `set_attachments_enabled`, `set_comments_enabled`, `set_llm_enabled` toggle it
  later; disabling keeps the data.
- Useful extras: `fork_share` copies files + capability config only (no data,
  attachments, comments, password, or history); `?embed=1` embeds a share,
  `?source=1` shows its source when enabled.

See [references/mcp-tools.md](references/mcp-tools.md) for the full tool list.
