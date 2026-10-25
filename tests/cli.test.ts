import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// CLI integration tests against a mock MCP HTTP endpoint: verifies the wire
// format (JSON-RPC tools/call + Bearer auth), argument mapping and output
// conventions without needing a real Gallery server or database.

const cliPath = path.join(process.cwd(), "cli", "gallery.mjs");
const workDir = mkdtempSync(path.join(tmpdir(), "gallery-cli-test-"));

interface RecordedRequest {
  authorization: string | undefined;
  method: string;
  tool: string;
  args: Record<string, unknown>;
}

const requests: RecordedRequest[] = [];
let server: Server;
let baseUrl = "";
let toolHandler: (tool: string, args: Record<string, unknown>) => unknown = (tool) => ({
  content: [{ type: "text", text: `ok ${tool}` }],
  structuredContent: { slug: "abc123", url: "https://gallery.test/s/abc123" },
});

function runCli(
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        GALLERY_URL: baseUrl,
        GALLERY_TOKEN: "test-token",
        // Never read the developer's real config during tests.
        GALLERY_CONFIG: path.join(workDir, "no-such-config.json"),
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Unauthorized" } }));
        return;
      }
      const message = JSON.parse(body);
      if (message.method === "ping") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return;
      }
      const tool = message.params.name as string;
      const args = (message.params.arguments ?? {}) as Record<string, unknown>;
      requests.push({ authorization: req.headers.authorization, method: message.method, tool, args });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: toolHandler(tool, args) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

test("upload sends a JSON-RPC tools/call with utf8 content and prints structured JSON", async () => {
  const file = path.join(workDir, "hello.html");
  writeFileSync(file, "<h1>你好</h1>");
  requests.length = 0;
  const result = await runCli(["upload", file, "--page-state", "--expires-in", "7d"]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.slug, "abc123");
  assert.equal(output.url, "https://gallery.test/s/abc123");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "tools/call");
  assert.equal(requests[0].tool, "upload_file");
  assert.deepEqual(requests[0].args, {
    filename: "hello.html",
    content: "<h1>你好</h1>",
    encoding: "utf8",
    pageStateEnabled: true,
    expiresIn: "7d",
  });
});

test("boolean flags may precede positionals and binary files use base64", async () => {
  const file = path.join(workDir, "pixel.png");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  requests.length = 0;
  const result = await runCli(["upload", "--kv", "--llm", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests[0].tool, "upload_file");
  assert.equal(requests[0].args.filename, "pixel.png");
  assert.equal(requests[0].args.encoding, "base64");
  assert.equal(requests[0].args.content, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).toString("base64"));
  assert.equal(requests[0].args.kvEnabled, true);
  assert.equal(requests[0].args.llmEnabled, true);
});

test("upload --dir creates the share from the entry then batches the remaining files", async () => {
  const dir = path.join(workDir, "site");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), "<main>site</main>");
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  requests.length = 0;
  const result = await runCli(["upload", "--dir", dir, "--page-state"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tool, "upload_file");
  assert.equal(requests[0].args.filename, "index.html");
  assert.equal(requests[1].tool, "upload_share_files");
  assert.equal(requests[1].args.slug, "abc123");
  assert.equal(requests[1].args.entryPath, "index.html");
  const files = requests[1].args.files as Array<{ path: string }>;
  assert.deepEqual(files.map((f) => f.path), ["assets/app.js"]);
});

test("call passes arbitrary tools and arguments through, including stdin JSON", async () => {
  requests.length = 0;
  const result = await runCli(
    ["call", "set_kv_enabled", "-"],
    { input: JSON.stringify({ slug: "abc123", enabled: true }) },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests[0].tool, "set_kv_enabled");
  assert.deepEqual(requests[0].args, { slug: "abc123", enabled: true });
});

test("kv put parses JSON values and CAS flags", async () => {
  requests.length = 0;
  const result = await runCli([
    "kv", "put", "abc123", "todos", "row1", '{"done":false}', "--base-version", "3", "--if-absent",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests[0].tool, "kv_put");
  assert.deepEqual(requests[0].args, {
    slug: "abc123",
    collection: "todos",
    key: "row1",
    value: { done: false },
    baseVersion: 3,
    ifAbsent: true,
  });
});

test("tool-level isError exits 1 with a JSON error on stderr", async () => {
  toolHandler = () => ({ content: [{ type: "text", text: "分享不存在" }], isError: true });
  const result = await runCli(["files", "missing"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.type, "tool");
  assert.match(JSON.parse(result.stderr).error.message, /分享不存在/);
  toolHandler = (tool) => ({ content: [{ type: "text", text: `ok ${tool}` }] });
});

test("destructive commands require --yes (usage error, no request sent)", async () => {
  requests.length = 0;
  const refused = await runCli(["rm", "abc123"]);
  assert.equal(refused.code, 2);
  assert.equal(requests.length, 0);
  const confirmed = await runCli(["rm", "abc123", "--yes"]);
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(requests[0].tool, "delete_share");
});

test("unauthorized responses produce a clear error", async () => {
  const result = await runCli(["ping"], { env: { GALLERY_TOKEN: "wrong-token" } });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error.message, /Unauthorized/);
});

test("missing config fails fast with setup guidance", async () => {
  const result = await runCli(["ls"], { env: { GALLERY_URL: "", GALLERY_TOKEN: "" } });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error.message, /No server URL/);
});
