#!/usr/bin/env node
// Gallery CLI — zero-dependency thin client for the Gallery MCP HTTP endpoint.
// Usage: node cli/gallery.mjs <command> ... (or `gallery ...` when linked/aliased).
// Success: JSON result on stdout, exit 0. Failure: JSON error on stderr, exit != 0.

import { readFileSync, readdirSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const USAGE = `Gallery CLI — talks to a Gallery server's /api/mcp endpoint (Bearer API token).

Config (highest priority first): --url/--token flags, GALLERY_URL/GALLERY_TOKEN env,
config file written by \`gallery init\` (~/.config/gallery/config.json, mode 600).
Create tokens in the Gallery web UI at /settings/tokens.

Commands:
  init --url <url> --token <token>   Save config file
  config                             Show effective config (token redacted)
  ping                               Check connectivity and authentication
  tools                              List available MCP tools (name/description/inputSchema)
  call <tool> [json|@file|-]         Call any tool with a JSON argument object

  upload <file>                      Upload one file, returns { slug, url, ... }
  upload --dir <dir> [--entry p]     Upload a multi-file artifact (entry default index.html)
    Options: --name <filename>  --runtime static|react  --expires-in 7d
             --password <pw> | --password-stdin
             --page-state --visitor-state --kv --comments --attachments --llm
             --llm-model <model> --llm-daily-token-budget <n>
  ls                                 List your shares
  files <slug>                       List files of a share
  put-file <slug> <localFile> [--path <sharePath>]
  put-files <slug> --dir <dir> [--entry <entryPath>]
  rm-file <slug> <path>
  rm <slug> --yes                    Delete a share and its data (irreversible)

  password <slug> <pw> | --stdin     Set/change share password (invalidates visitor tokens)
  password <slug> --remove           Remove share password
  expiry <slug> <30m|12h|7d|never>   Set or clear expiry

  kv list <slug> <collection> [--prefix p] [--limit n] [--cursor c]
  kv get <slug> <collection> <key>
  kv put <slug> <collection> <key> <json|@file|-> [--base-version n] [--if-absent]
  kv del <slug> <collection> <key> [--base-version n]
  kv clear <slug> <collection> --yes Irreversibly clear a collection

  versions <slug>                    List version snapshots
  publish-version <slug> <versionNo> Publish a historical version
  rollback <slug> <versionNo>        Roll back current files to a version

Global options: --url <url> --token <token> --timeout <ms> --text (human output)
Exit codes: 0 ok, 1 tool/transport error, 2 usage error.`;

// ---------- argument parsing ----------

// Flags that never consume a following value (so they can precede positionals).
const BOOLEAN_FLAGS = new Set([
  "page-state", "visitor-state", "kv", "comments", "attachments", "llm",
  "password-stdin", "stdin", "remove", "if-absent", "yes",
  "text", "help", "h", "version",
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { flags, positional };
}

function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function str(flags, name) {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function int(flags, name) {
  const raw = str(flags, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usageError(`--${name} must be a non-negative integer`);
  return Number(raw);
}

function required(value, message) {
  if (value === undefined || value === true || value === "") throw usageError(message);
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${what} is not valid JSON`);
  }
}

// JSON inline, @path to a JSON file, or "-" for stdin.
async function jsonArg(raw, what) {
  if (raw === undefined) return undefined;
  if (raw === "-") return parseJson(await readStdin(), what);
  if (raw.startsWith("@")) return parseJson(readFileSync(raw.slice(1), "utf8"), what);
  return parseJson(raw, what);
}

// ---------- config ----------

function configPath() {
  if (process.env.GALLERY_CONFIG) return process.env.GALLERY_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gallery", "config.json");
}

function readConfigFile() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function effectiveConfig(flags) {
  const file = readConfigFile();
  const url = str(flags, "url") || process.env.GALLERY_URL || file.url;
  const token = str(flags, "token") || process.env.GALLERY_TOKEN || file.token;
  return { url, token };
}

// ---------- transport ----------

async function rpc(config, flags, method, params) {
  if (!config.url) throw new Error("No server URL. Set --url, GALLERY_URL, or run `gallery init`.");
  if (!config.token) {
    throw new Error("No API token. Set --token, GALLERY_TOKEN, or run `gallery init` (tokens at /settings/tokens).");
  }
  const base = config.url.replace(/\/+$/, "");
  const endpoint = base.endsWith("/api/mcp") ? base : `${base}/api/mcp`;
  const timeout = int(flags, "timeout") ?? 120_000;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(`Cannot reach ${endpoint}: ${error.cause?.message || error.message}`);
  }
  const text = await response.text();
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status} from ${endpoint}: ${text.slice(0, 300)}`);
  }
  if (message.error) {
    const { code, message: msg } = message.error;
    if (response.status === 401) throw new Error("Unauthorized: check your API token.");
    if (response.status === 429) throw new Error("Rate limited by the server; retry later.");
    throw new Error(`JSON-RPC error ${code}: ${msg}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return message.result;
}

async function callTool(config, flags, name, args) {
  const result = await rpc(config, flags, "tools/call", { name, arguments: args ?? {} });
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
  if (result?.isError) {
    const err = new Error(text || `Tool ${name} failed`);
    err.tool = true;
    throw err;
  }
  return { text, data: result?.structuredContent };
}

// ---------- file helpers ----------

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function encodeFile(buffer) {
  // Text when it is valid UTF-8 without NUL bytes, base64 otherwise.
  try {
    const text = utf8Decoder.decode(buffer);
    if (!text.includes("\0")) return { content: text, encoding: "utf8" };
  } catch {
    // binary
  }
  return { content: buffer.toString("base64"), encoding: "base64" };
}

function collectDir(dir) {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git" || entry.name === ".DS_Store") continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk("");
  if (files.length === 0) throw new Error(`No files found in ${dir}`);
  if (files.length > 255) throw new Error(`Too many files (${files.length}); the limit is 255 per batch.`);
  return files.sort().map((rel) => ({ path: rel, ...encodeFile(readFileSync(path.join(dir, rel))) }));
}

function capabilityArgs(flags) {
  return {
    ...(flags["page-state"] ? { pageStateEnabled: true } : {}),
    ...(flags["visitor-state"] ? { visitorStateEnabled: true } : {}),
    ...(flags.kv ? { kvEnabled: true } : {}),
    ...(flags.comments ? { commentsEnabled: true } : {}),
    ...(flags.attachments ? { attachmentsEnabled: true } : {}),
    ...(flags.llm ? { llmEnabled: true } : {}),
    ...(str(flags, "llm-model") ? { llmModel: str(flags, "llm-model") } : {}),
    ...(int(flags, "llm-daily-token-budget")
      ? { llmDailyTokenBudget: int(flags, "llm-daily-token-budget") }
      : {}),
  };
}

async function passwordArg(flags) {
  if (flags["password-stdin"]) return (await readStdin()).replace(/\r?\n$/, "");
  return str(flags, "password");
}

// ---------- commands ----------

const commands = {
  async init({ flags }) {
    const url = required(str(flags, "url"), "init requires --url");
    const token = required(str(flags, "token"), "init requires --token");
    const file = configPath();
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fsp.writeFile(file, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(file, 0o600);
    return { text: `Config written to ${file}`, data: { configPath: file, url } };
  },

  async config({ flags }) {
    const { url, token } = effectiveConfig(flags);
    const data = {
      configPath: configPath(),
      url: url ?? null,
      token: token ? `${String(token).slice(0, 4)}…(redacted)` : null,
    };
    return { text: JSON.stringify(data), data };
  },

  async ping(ctx) {
    await rpc(ctx.config, ctx.flags, "ping", {});
    return { text: "pong", data: { ok: true, url: ctx.config.url } };
  },

  async tools({ config, flags }) {
    const result = await rpc(config, flags, "tools/list", {});
    const tools = result.tools ?? [];
    return {
      text: tools.map((t) => t.name).join("\n"),
      data: { count: tools.length, tools },
    };
  },

  async call({ config, flags, positional }) {
    const name = required(positional[0], "call requires a tool name (see `gallery tools`)");
    const args = (await jsonArg(positional[1], "Tool arguments")) ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw usageError("Tool arguments must be a JSON object");
    }
    return callTool(config, flags, name, args);
  },

  async upload({ config, flags, positional }) {
    const password = await passwordArg(flags);
    const common = {
      ...capabilityArgs(flags),
      ...(str(flags, "runtime") ? { runtime: str(flags, "runtime") } : {}),
      ...(password ? { password } : {}),
      ...(str(flags, "expires-in") ? { expiresIn: str(flags, "expires-in") } : {}),
    };
    if (str(flags, "dir")) {
      const dir = str(flags, "dir");
      const files = collectDir(dir);
      const entry = str(flags, "entry") ?? "index.html";
      const entryFile = files.find((f) => f.path === entry);
      if (!entryFile) throw new Error(`Entry ${entry} not found in ${dir}`);
      const created = await callTool(config, flags, "upload_file", {
        filename: entry,
        content: entryFile.content,
        encoding: entryFile.encoding,
        ...common,
      });
      const slug = created.data?.slug;
      if (!slug) throw new Error("Upload succeeded but no slug was returned");
      const rest = files.filter((f) => f.path !== entry);
      if (rest.length > 0) {
        await callTool(config, flags, "upload_share_files", { slug, files: rest, entryPath: entry });
      }
      return {
        text: created.text,
        data: { ...created.data, files: files.length, entryPath: entry },
      };
    }
    const local = required(positional[0], "upload requires a file path or --dir");
    const buffer = readFileSync(local);
    const filename = str(flags, "name") ?? path.basename(local);
    return callTool(config, flags, "upload_file", {
      filename,
      ...encodeFile(buffer),
      ...common,
    });
  },

  async ls(ctx) {
    return callTool(ctx.config, ctx.flags, "list_shares", {});
  },

  async files({ config, flags, positional }) {
    const slug = required(positional[0], "files requires a slug");
    return callTool(config, flags, "list_share_files", { slug });
  },

  async "put-file"({ config, flags, positional }) {
    const slug = required(positional[0], "put-file requires <slug> <localFile>");
    const local = required(positional[1], "put-file requires <slug> <localFile>");
    const sharePath = str(flags, "path") ?? path.basename(local);
    return callTool(config, flags, "update_share_file", {
      slug,
      path: sharePath,
      ...encodeFile(readFileSync(local)),
    });
  },

  async "put-files"({ config, flags, positional }) {
    const slug = required(positional[0], "put-files requires <slug> --dir <dir>");
    const dir = required(str(flags, "dir"), "put-files requires --dir");
    const args = { slug, files: collectDir(dir) };
    if (str(flags, "entry")) args.entryPath = str(flags, "entry");
    return callTool(config, flags, "upload_share_files", args);
  },

  async "rm-file"({ config, flags, positional }) {
    const slug = required(positional[0], "rm-file requires <slug> <path>");
    const filePath = required(positional[1], "rm-file requires <slug> <path>");
    return callTool(config, flags, "delete_share_file", { slug, path: filePath });
  },

  async rm({ config, flags, positional }) {
    const slug = required(positional[0], "rm requires <slug> --yes");
    confirm(flags, `delete share ${slug} and all its data`);
    return callTool(config, flags, "delete_share", { slug });
  },

  async password({ config, flags, positional }) {
    const slug = required(positional[0], "password requires a slug");
    if (flags.remove) return callTool(config, flags, "remove_password", { slug });
    const password = flags.stdin
      ? (await readStdin()).replace(/\r?\n$/, "")
      : required(positional[1], "password requires <slug> <password>, --stdin, or --remove");
    return callTool(config, flags, "set_password", { slug, password });
  },

  async expiry({ config, flags, positional }) {
    const slug = required(positional[0], "expiry requires <slug> <duration|never>");
    const duration = required(positional[1], "expiry requires <slug> <duration|never>");
    return callTool(config, flags, "set_expiry", { slug, expiresIn: duration });
  },

  async kv({ config, flags, positional }) {
    const [action, slug, collection, key, ...rest] = positional;
    required(action, "kv requires list|get|put|del|clear");
    required(slug, "kv requires a slug");
    required(collection, "kv requires a collection");
    switch (action) {
      case "list":
        return callTool(config, flags, "kv_list", {
          slug,
          collection,
          ...(str(flags, "prefix") ? { prefix: str(flags, "prefix") } : {}),
          ...(str(flags, "cursor") ? { cursor: str(flags, "cursor") } : {}),
          ...(int(flags, "limit") ? { limit: int(flags, "limit") } : {}),
        });
      case "get":
        return callTool(config, flags, "kv_get", { slug, collection, key: required(key, "kv get requires a key") });
      case "put": {
        required(key, "kv put requires a key");
        const value = await jsonArg(required(rest[0], "kv put requires a JSON value, @file, or -"), "KV value");
        return callTool(config, flags, "kv_put", {
          slug,
          collection,
          key,
          value,
          ...(int(flags, "base-version") !== undefined ? { baseVersion: int(flags, "base-version") } : {}),
          ...(flags["if-absent"] ? { ifAbsent: true } : {}),
        });
      }
      case "del":
        return callTool(config, flags, "kv_delete", {
          slug,
          collection,
          key: required(key, "kv del requires a key"),
          ...(int(flags, "base-version") !== undefined ? { baseVersion: int(flags, "base-version") } : {}),
        });
      case "clear":
        confirm(flags, `clear KV collection ${collection} on ${slug}`);
        return callTool(config, flags, "kv_clear_collection", { slug, collection });
      default:
        throw usageError(`Unknown kv action: ${action}`);
    }
  },

  async versions({ config, flags, positional }) {
    const slug = required(positional[0], "versions requires a slug");
    return callTool(config, flags, "list_versions", { slug });
  },

  async "publish-version"({ config, flags, positional }) {
    const slug = required(positional[0], "publish-version requires <slug> <versionNo>");
    const versionNo = Number(required(positional[1], "publish-version requires a version number"));
    return callTool(config, flags, "publish_version", { slug, versionNo });
  },

  async rollback({ config, flags, positional }) {
    const slug = required(positional[0], "rollback requires <slug> <versionNo>");
    const versionNo = Number(required(positional[1], "rollback requires a version number"));
    return callTool(config, flags, "rollback_to_version", { slug, versionNo });
  },
};

function confirm(flags, what) {
  if (!flags.yes) throw usageError(`Refusing to ${what} without --yes (irreversible).`);
}

// ---------- entrypoint ----------

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const [commandName, ...rest] = positional;
  if (!commandName || flags.help || flags.h || commandName === "help") {
    console.log(USAGE);
    return;
  }
  if (flags.version || commandName === "version") {
    console.log(JSON.stringify({ name: "gallery-cli", version: "0.1.0" }));
    return;
  }
  const command = commands[commandName];
  if (!command) throw usageError(`Unknown command: ${commandName}. Run with --help for usage.`);
  const { text, data } = await command({
    flags,
    positional: rest,
    config: effectiveConfig(flags),
  });
  if (flags.text) console.log(text ?? JSON.stringify(data ?? {}, null, 2));
  else console.log(JSON.stringify(data ?? { text }, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: {
          message: error.message,
          ...(error.tool ? { type: "tool" } : {}),
          ...(error.usage ? { type: "usage", hint: "Run with --help for usage." } : {}),
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = error.usage ? 2 : 1;
});
