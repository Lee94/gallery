# Gallery CLI

A zero-dependency Node.js client for a Gallery server. It speaks JSON-RPC
directly to the existing `/api/mcp` endpoint with a Bearer API token — no new
server-side API, no npm dependencies, no build step. Every MCP tool is reachable,
so the CLI never lags behind the server's feature set.

Requires Node.js 18+ (built-in `fetch`). The file is `cli/gallery.mjs` in the
Gallery repository.

## Setup

```bash
# run it directly…
node cli/gallery.mjs --help

# …or put it on your PATH
alias gallery='node /path/to/gallery/cli/gallery.mjs'
# or, from the repository root (adds a `gallery` bin via package.json):
pnpm link --global
```

Create an API token in the Gallery web UI at `/settings/tokens`, then either:

```bash
gallery init --url https://share.example.com --token <token>   # writes ~/.config/gallery/config.json, mode 600
```

or use environment variables (better for agents and CI — nothing on disk):

```bash
export GALLERY_URL=https://share.example.com
export GALLERY_TOKEN=<token>
```

Precedence: `--url`/`--token` flags → `GALLERY_URL`/`GALLERY_TOKEN` → config file
(`$GALLERY_CONFIG` overrides its location). Tokens are never accepted as
positional arguments, and `gallery config` redacts them.

## Output contract (agent-friendly)

- Success: the tool's `structuredContent` as pretty JSON on **stdout**, exit 0.
  Uploads therefore print `{ "slug": …, "url": … }` ready to parse.
- Failure: `{ "error": { "message": … } }` as JSON on **stderr**; exit 1 for
  tool/transport errors, 2 for usage errors.
- `--text` switches stdout to the server's human-readable text.

## Everyday commands

```bash
gallery ping                                  # connectivity + auth check
gallery upload report.html                    # → { slug, url, … }
gallery upload chart.png                      # binary is base64-encoded automatically
gallery upload app.jsx --runtime react --page-state
gallery upload --dir ./dist --entry index.html --expires-in 7d
gallery upload poll.html --page-state --password-stdin < pw.txt

gallery ls
gallery files abc123
gallery put-file abc123 index.html            # update in place, same URL
gallery put-file abc123 ./logo.png --path assets/logo.png
gallery put-files abc123 --dir ./dist --entry index.html

gallery password abc123 --remove
gallery expiry abc123 7d
gallery versions abc123
gallery rollback abc123 2

gallery kv put abc123 todos row1 '{"text":"milk","done":false}' --if-absent
gallery kv list abc123 todos --limit 50
gallery kv get abc123 todos row1
```

Destructive commands (`rm`, `kv clear`) refuse to run without `--yes`.

## The escape hatch: `call` and `tools`

Every MCP tool in `src/lib/mcp/tools.ts` works through the same two commands:

```bash
gallery tools                                 # names + JSON input schemas
gallery call set_kv_policy '{"slug":"abc123","collection":"todos","readMode":"all","writeMode":"creator","deleteMode":"creator"}'
gallery call update_share_metadata @meta.json # arguments from a JSON file
gallery call set_llm_enabled - <<'JSON'       # …or from stdin
{"slug":"abc123","enabled":true,"llmDailyTokenBudget":20000}
JSON
```

The skills in `../skills` treat `gallery call <tool> <json>` as the exact
equivalent of the MCP tool of the same name, so their guidance applies unchanged
when MCP is not available.

## Scope and limits

- Acts only on shares owned by the token's user, same as MCP.
- Single file size, page-state size, KV and attachment quotas are enforced by
  the server (`MAX_FILE_SIZE_MB` etc.), not by the CLI.
- `upload --dir` follows regular files only (no symlinks), skips `.git` and
  `.DS_Store`, and is limited to 255 files per batch.
- The CLI is a client: it never touches the server's SQLite database or data
  directory, and works from any machine that can reach the server.
