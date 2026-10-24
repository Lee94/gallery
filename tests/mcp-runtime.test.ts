import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "gallery-mcp-react-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: process.cwd(), env: process.env, stdio: "pipe" });

const modules = (async () => {
  const [{ getDb }, schema, create, server, manage] = await Promise.all([
    import("../src/db/index"),
    import("../src/db/schema"),
    import("../src/lib/shares/create"),
    import("../src/lib/mcp/server"),
    import("../src/lib/shares/manage"),
  ]);
  return { getDb, schema, create, server, manage };
})();
const contextReady = modules.then(async ({ getDb, schema, create }) => {
  getDb().insert(schema.users).values({
    id: "mcp-react-owner",
    email: "mcp-react@example.test",
    passwordHash: "unused",
    role: "user",
    createdAt: Date.now(),
  }).run();
  const user = getDb().select().from(schema.users).get()!;
  const source = new TextEncoder().encode("export default () => <main>React MCP</main>;");
  const created = await create.createShare({
    ownerId: user.id,
    filename: "index.jsx",
    content: source,
    size: source.length,
    runtime: "react",
  });
  return { user, share: created.share };
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

async function callTool(name: string, args: Record<string, unknown>) {
  const [{ user }, { server }] = await Promise.all([contextReady, modules]);
  const response = await server.handleMcpMessage(user, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }) as { result: { isError?: boolean; structuredContent?: unknown } };
  return response.result;
}

test("MCP 批量更新拒绝非 JSX 的 React 入口且不写文件", async () => {
  const [{ share }, { manage }] = await Promise.all([contextReady, modules]);
  const result = await callTool("upload_share_files", {
    slug: share.slug,
    entryPath: "index.html",
    files: [{ path: "index.html", content: "<h1>wrong runtime</h1>" }],
  });
  assert.equal(result.isError, true);
  assert.equal(manage.listShareFiles(share.id).some((file) => file.path === "index.html"), false);
});

test("MCP 批量更换 React 入口后仍保持 HTML 对外元数据", async () => {
  const [{ share }, { getDb, schema }] = await Promise.all([contextReady, modules]);
  const result = await callTool("upload_share_files", {
    slug: share.slug,
    entryPath: "App.tsx",
    files: [{ path: "App.tsx", content: "export default () => <main>Updated</main>;" }],
  });
  assert.notEqual(result.isError, true);
  const updated = getDb().select().from(schema.shares).get()!;
  assert.equal(updated.entryPath, "App.tsx");
  assert.equal(updated.runtime, "react");
  assert.equal(updated.kind, "html");
  assert.equal(updated.mimeType, "text/html");
});
