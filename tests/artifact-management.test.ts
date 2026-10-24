import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { TextEncoder } from "node:util";

const dataDir = mkdtempSync(path.join(tmpdir(), "gallery-management-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
execFileSync(process.execPath, ["scripts/migrate.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "pipe",
});

const modules = (async () => {
  const [{ getDb }, schema, create, manage, kv, comments, versions, storage, events, compatibility, pageState, visitorState, attachments] =
    await Promise.all([
      import("../src/db/index"),
      import("../src/db/schema"),
      import("../src/lib/shares/create"),
      import("../src/lib/shares/manage"),
      import("../src/lib/shares/kv"),
      import("../src/lib/shares/comments"),
      import("../src/lib/shares/versions"),
      import("../src/lib/storage"),
      import("../src/lib/share-events"),
      import("../src/lib/shares/data-compatibility"),
      import("../src/lib/shares/page-state"),
      import("../src/lib/shares/visitor-state"),
      import("../src/lib/shares/attachments"),
    ]);
  return { getDb, schema, create, manage, kv, comments, versions, storage, events, compatibility, pageState, visitorState, attachments };
})();

const now = Date.now();
const ownerId = "test-owner-0001";
const otherUserId = "test-owner-0002";
const usersReady = modules.then(({ getDb, schema }) => {
  const db = getDb();
  db.insert(schema.users)
    .values([
      {
        id: ownerId,
        email: "owner@example.test",
        passwordHash: "unused-in-this-test",
        role: "user",
        createdAt: now,
      },
      {
        id: otherUserId,
        email: "other@example.test",
        passwordHash: "unused-in-this-test",
        role: "user",
        createdAt: now,
      },
    ])
    .run();
});

function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

async function createHtml(options: { kv?: boolean; comments?: boolean } = {}) {
  await usersReady;
  const { create } = await modules;
  const html = bytes("<!doctype html><h1>v1</h1>");
  const js = bytes("console.log('v1')");
  return create.createShare({
    ownerId,
    filename: "index.html",
    files: [
      { path: "index.html", content: html, size: html.length },
      { path: "js/app.js", content: js, size: js.length },
    ],
    entryPath: "index.html",
    pageStateEnabled: true,
    kvEnabled: options.kv,
    commentsEnabled: options.comments,
  });
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("多文件创建会生成入口、文件清单和初始版本", async () => {
  const created = await createHtml();
  const { manage, versions } = await modules;
  assert.equal(created.share.kind, "html");
  assert.equal(created.share.entryPath, "index.html");
  assert.deepEqual(
    manage.listShareFiles(created.share.id).map((file) => file.path),
    ["index.html", "js/app.js"],
  );
  const history = versions.listVersions(created.share.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.label, "initial");
  assert.equal(history[0]?.fileCount, 2);
});

test("能力开关始终校验所有权与文件类型", async () => {
  const created = await createHtml();
  const { manage, create } = await modules;
  const denied = manage.setShareKvEnabledFor(otherUserId, created.share.id, true);
  assert.match(denied.error ?? "", /无权操作/);

  const text = bytes("plain text");
  const textShare = await create.createShare({
    ownerId,
    filename: "notes.txt",
    content: text,
    size: text.length,
  });
  assert.match(
    manage.setShareKvEnabledFor(ownerId, textShare.share.id, true).error ?? "",
    /只有 HTML/,
  );
  assert.match(
    manage.setSharePageStateEnabledFor(ownerId, textShare.share.id, true).error ?? "",
    /只有 HTML/,
  );
  assert.equal(manage.setShareCommentsEnabledFor(ownerId, textShare.share.id, true).error, undefined);
});

test("文本更新、打标签和回滚都保留追加式版本历史", async () => {
  const created = await createHtml();
  const { manage, storage, versions } = await modules;
  const updated = bytes("<!doctype html><h1>v2</h1>");
  await storage.saveFile(created.share.id, "index.html", updated);
  const mutation = await manage.upsertShareFileFor(
    ownerId,
    created.share.id,
    "index.html",
    updated.length,
  );
  assert.equal(mutation.error, undefined);
  assert.equal(versions.listVersions(created.share.id).length, 2);

  const published = await manage.publishShareVersionFor(
    ownerId,
    created.share.id,
    "ready for review",
  );
  assert.equal(published.error, undefined);
  assert.equal(published.versionNo, 3);

  const rolledBack = await manage.rollbackShareVersionFor(ownerId, created.share.id, 1);
  assert.equal(rolledBack.error, undefined);
  assert.equal(rolledBack.versionNo, 4);
  assert.equal(
    await storage.readFileText(created.share.id, "index.html"),
    "<!doctype html><h1>v1</h1>",
  );
  assert.equal(versions.listVersions(created.share.id)[0]?.label, "rollback to v1");
});

test("KV collection 清理只允许 owner，并按 collection 隔离", async () => {
  const created = await createHtml({ kv: true });
  const { kv, manage } = await modules;
  kv.kvPut(created.share.id, "votes", "a", "1", 1);
  kv.kvPut(created.share.id, "votes", "b", "2", 1);
  kv.kvPut(created.share.id, "other", "c", "3", 1);

  const denied = manage.clearShareKvCollectionFor(otherUserId, created.share.id, "votes");
  assert.match(denied.error ?? "", /无权操作/);
  assert.equal(kv.kvList(created.share.id, "votes").items.length, 2);

  const cleared = manage.clearShareKvCollectionFor(ownerId, created.share.id, "votes");
  assert.equal(cleared.error, undefined);
  assert.equal(cleared.cleared, 2);
  assert.equal(kv.kvList(created.share.id, "votes").items.length, 0);
  assert.equal(kv.kvList(created.share.id, "other").items.length, 1);
});

test("owner 评论回复与审核共用所有权校验", async () => {
  const created = await createHtml({ comments: true });
  const { manage, comments } = await modules;
  const added = manage.addShareOwnerCommentFor(ownerId, created.share.id, "  已收到反馈  ");
  assert.equal(added.error, undefined);
  assert.ok(added.commentId);
  const commentId = added.commentId!;

  assert.match(
    manage.setShareCommentStatusFor(otherUserId, created.share.id, commentId, "hidden").error ?? "",
    /无权操作/,
  );
  assert.equal(
    manage.setShareCommentStatusFor(ownerId, created.share.id, commentId, "hidden").error,
    undefined,
  );
  const items = comments.listComments(created.share.id, { includeHidden: true });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.body, "已收到反馈");
  assert.equal(items[0]?.status, "hidden");
});

test("入口文件不能删除，附属文件删除后生成新版本", async () => {
  const created = await createHtml();
  const { manage, versions } = await modules;
  assert.match(
    (await manage.deleteShareFileFor(ownerId, created.share.id, "index.html")).error ?? "",
    /不能删除入口文件/,
  );
  const result = await manage.deleteShareFileFor(ownerId, created.share.id, "js/app.js");
  assert.equal(result.error, undefined);
  assert.deepEqual(
    manage.listShareFiles(created.share.id).map((file) => file.path),
    ["index.html"],
  );
  assert.equal(versions.listVersions(created.share.id).length, 2);
});

test("数据版本头区分旧客户端、schema 冲突和数据空间冲突", async () => {
  const created = await createHtml();
  const { compatibility } = await modules;
  const current = { dataGeneration: 2, dataSchemaVersion: 3 };
  assert.equal(compatibility.checkDataCompatibility(new Headers(), current), null);
  assert.equal(
    compatibility.checkDataCompatibility(
      new Headers({
        "x-gallery-data-generation": "2",
        "x-gallery-data-schema-version": "3",
      }),
      current,
    ),
    null,
  );
  assert.equal(
    compatibility.checkDataCompatibility(
      new Headers({ "x-gallery-data-generation": String(created.share.dataGeneration) }),
      current,
    )?.body.code,
    "data_generation_conflict",
  );
  assert.equal(
    compatibility.checkDataCompatibility(
      new Headers({ "x-gallery-data-schema-version": "2" }),
      current,
    )?.body.code,
    "schema_version_conflict",
  );
  assert.equal(
    compatibility.checkDataCompatibility(
      new Headers({ "x-gallery-data-generation": "0" }),
      current,
    )?.status,
    400,
  );
});

test("KV creator ACL 只允许本人和 owner，旧空创建者行不可被访客接管", async () => {
  const created = await createHtml({ kv: true });
  const { kv, manage } = await modules;
  const policy = {
    collection: "private-rows",
    readMode: "all",
    writeMode: "creator",
    deleteMode: "creator",
  } as const;
  assert.equal(manage.setShareKvPolicyFor(ownerId, created.share.id, policy).error, undefined);
  const saved = kv.getKvPolicy(created.share.id, "private-rows");
  assert.equal(kv.canReadKvPolicy(saved, false), true);
  assert.equal(kv.canMutateKvPolicy(saved, "write", false, "visitor-a", "visitor-a"), true);
  assert.equal(kv.canMutateKvPolicy(saved, "delete", false, "visitor-b", "visitor-a"), false);
  assert.equal(kv.canMutateKvPolicy(saved, "write", false, null, null), false);
  assert.equal(kv.canMutateKvPolicy(saved, "write", true, null, null), true);

  kv.kvPut(created.share.id, "private-rows", "a", "1", 1, { creatorKey: "visitor-a" });
  assert.equal(kv.kvGetRecord(created.share.id, "private-rows", "a")?.creatorKey, "visitor-a");
  assert.equal("creatorKey" in (kv.kvGet(created.share.id, "private-rows", "a") ?? {}), false);
});

test("新建数据空间清空所有数据并使旧 generation 失效", async () => {
  const created = await createHtml({ kv: true });
  const { kv, manage, pageState, visitorState, compatibility } = await modules;
  pageState.savePageState(created.share.id, 0, '{"count":1}', 11);
  visitorState.saveVisitorState(created.share.id, "visitor-a", 0, '{"private":true}', 16);
  kv.kvPut(created.share.id, "default", "a", "1", 1);

  const reset = manage.resetShareDataSpaceFor(ownerId, created.share.id);
  assert.equal(reset.error, undefined);
  assert.equal(reset.dataGeneration, created.share.dataGeneration + 1);
  assert.equal(kv.kvCountRows(created.share.id), 0);
  assert.equal(visitorState.getVisitorStateSnapshot(created.share.id, "visitor-a"), null);
  assert.equal(pageState.getPageStateSnapshot(created.share.id)?.data, null);
  assert.equal(
    compatibility.checkDataCompatibility(
      new Headers({ "x-gallery-data-generation": String(created.share.dataGeneration) }),
      { dataGeneration: reset.dataGeneration!, dataSchemaVersion: 1 },
    )?.body.code,
    "data_generation_conflict",
  );
});

test("访客附件按创建者和 shared 可见性隔离，公开视图不含 creatorKey", async () => {
  const created = await createHtml();
  const { attachments, storage } = await modules;
  const input = {
    shareId: created.share.id,
    creatorKey: "visitor-a",
    originalName: "proof.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  } as const;
  const privateFile = attachments.reserveAttachment({ ...input, visibility: "private" });
  assert.ok(!("error" in privateFile));
  await storage.saveAttachment(privateFile.id, bytes("data"));
  assert.equal(await storage.readAttachment(privateFile.id).then((b) => b.toString()), "data");
  assert.equal(
    attachments.getAccessibleAttachment(created.share.id, privateFile.id, "visitor-b", false),
    null,
  );
  assert.equal(
    attachments.getAccessibleAttachment(created.share.id, privateFile.id, "visitor-a", false)?.id,
    privateFile.id,
  );
  const sharedFile = attachments.reserveAttachment({ ...input, originalName: "shared.txt", visibility: "shared" });
  assert.ok(!("error" in sharedFile));
  assert.equal(
    attachments.getAccessibleAttachment(created.share.id, sharedFile.id, "visitor-b", false)?.id,
    sharedFile.id,
  );
  const otherView = attachments.listAttachments(created.share.id, "visitor-b", false);
  assert.deepEqual(otherView.map((item) => item.id), [sharedFile.id]);
  assert.equal("creatorKey" in otherView[0]!, false);
  assert.equal(attachments.listAttachments(created.share.id, "owner", true).length, 2);
  attachments.releaseAttachment(created.share.id, privateFile.id);
  await storage.deleteAttachment(privateFile.id);
  attachments.releaseAttachment(created.share.id, sharedFile.id);
});

test("SSE 事件支持订阅去重、重放和序号过旧后的 reset", async () => {
  const { events } = await modules;
  const shareId = "event-test-share";
  const received: number[] = [];
  const unsubscribe = events.subscribeShareEvents(shareId, (event) => received.push(event.id));
  const first = events.publishShareEvent(shareId, "page-state", { version: 1 });
  const second = events.publishShareEvent(shareId, "kv", { collection: "votes", key: "a" });
  assert.deepEqual(received, [first.id, second.id]);
  const replay = events.replayShareEvents(shareId, first.id);
  assert.equal(replay.reset, false);
  assert.deepEqual(replay.events.map((event) => event.id), [second.id]);
  assert.equal(events.replayShareEvents(shareId, second.id + 100).reset, true);
  unsubscribe();
});

test("元数据封面校验、固定与手动排序都限制在 owner 范围内", async () => {
  const first = await createHtml();
  const second = await createHtml();
  const { manage } = await modules;
  assert.match(
    manage.setShareMetadataFor(ownerId, first.share.id, {
      title: "标题",
      description: "描述",
      icon: "✨",
      coverPath: "index.html",
      sourceEnabled: true,
    }).error ?? "",
    /封面/,
  );
  assert.equal(manage.setShareMetadataFor(ownerId, first.share.id, {
    title: "标题",
    description: "描述",
    icon: "✨",
    coverPath: null,
    sourceEnabled: false,
  }).error, undefined);
  assert.equal(manage.setSharePinnedFor(otherUserId, first.share.id, true).error !== undefined, true);
  assert.equal(manage.setSharePinnedFor(ownerId, first.share.id, true).error, undefined);
  const before = manage.listSharesFor(ownerId).map((share) => share.id);
  assert.equal(manage.moveShareFor(ownerId, second.share.id, 1).error, undefined);
  const after = manage.listSharesFor(ownerId).map((share) => share.id);
  assert.notDeepEqual(before, after);
});

test("Fork 复制文件和能力但不复制数据、附件、评论或历史", async () => {
  const source = await createHtml({ kv: true, comments: true });
  const { manage, kv, pageState, attachments, comments } = await modules;
  kv.kvPut(source.share.id, "default", "a", "1", 1);
  pageState.savePageState(source.share.id, 0, '{"source":true}', 15);
  attachments.reserveAttachment({
    shareId: source.share.id,
    creatorKey: "visitor-a",
    originalName: "private.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    visibility: "private",
  });
  manage.addShareOwnerCommentFor(ownerId, source.share.id, "source comment");
  const forked = await manage.forkShareFor(otherUserId, source.share.id);
  assert.equal(forked.error, undefined);
  assert.ok(forked.slug);
  const found = manage.findOwnedShareBySlug(otherUserId, forked.slug!);
  assert.ok(!("error" in found));
  assert.equal(found.share.forkedFromSlug, source.share.slug);
  assert.equal(found.share.kvEnabled, true);
  assert.equal(kv.kvCountRows(found.share.id), 0);
  assert.equal(pageState.getPageStateSnapshot(found.share.id)?.data, null);
  assert.equal(attachments.listAttachments(found.share.id, "owner", true).length, 0);
  assert.equal(comments.listComments(found.share.id, { includeHidden: true }).length, 0);
  assert.equal(manage.listShareFiles(found.share.id).length, 2);
});
