import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "gallery-react-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
const modules = (async () => {
  const [runtime, config] = await Promise.all([
    import("../src/lib/shares/react-runtime"),
    import("../src/lib/runtime-config"),
  ]);
  return { runtime, config };
})();

after(() => rmSync(dataDir, { recursive: true, force: true }));

function source(path: string, content: string) {
  return { path, content: new TextEncoder().encode(content) };
}

test("React Artifact 打包相对 JSX/CSS 并复用内容寻址缓存", async () => {
  const { runtime, config } = await modules;
  const files = [
    source("index.jsx", 'import Message from "./components/Message"; import "./style.css"; export default function App(){ return <main className="app"><Message /></main>; }'),
    source("components/Message.jsx", "export default function Message(){ return <h1>Hello React Artifact</h1>; }"),
    source("style.css", ".app { color: rgb(1, 2, 3); }"),
  ];
  const input = { files, entryPath: "index.jsx", runtimeVersion: config.REACT_RUNTIME_VERSION };
  const html = await runtime.buildReactArtifact(input);
  assert.match(html, /id="root"/);
  assert.match(html, /Hello React Artifact/);
  assert.match(html, /sdk\/page-state-v1\.js/);
  assert.match(html, /<style>/);
  const cached = await runtime.buildReactArtifact(input);
  assert.equal(cached, html);
});

test("React 依赖白名单拒绝未声明包", async () => {
  const { runtime, config } = await modules;
  const html = await runtime.buildReactArtifact({
    files: [source("index.jsx", 'import _ from "lodash"; export default () => <div>{_.camelCase("x")}</div>;')],
    entryPath: "index.jsx",
    runtimeVersion: config.REACT_RUNTIME_VERSION,
  });
  assert.match(html, /Artifact 构建失败/);
  assert.match(html, /不在白名单/);
});

test("React 相对导入不能越出 Artifact 根目录", async () => {
  const { runtime, config } = await modules;
  const html = await runtime.buildReactArtifact({
    files: [source("index.jsx", 'import secret from "../../secret"; export default () => <div>{secret}</div>;')],
    entryPath: "index.jsx",
    runtimeVersion: config.REACT_RUNTIME_VERSION,
  });
  assert.match(html, /Artifact 构建失败/);
  assert.match(html, /无法解析相对导入/);
});

test("React 运行时版本不匹配时明确报错而不动态安装", async () => {
  const { runtime } = await modules;
  const html = await runtime.buildReactArtifact({
    files: [source("index.jsx", "export default () => <div />;")],
    entryPath: "index.jsx",
    runtimeVersion: "18.2.0",
  });
  assert.match(html, /服务器仅提供/);
});
