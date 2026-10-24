/* Gallery 共享页面数据 SDK v1。用经典 <script> 引入，无依赖。 */
(function () {
  "use strict";

  var NAMESPACE = "gallery-page-state";
  var PROTOCOL_VERSION = 1;
  var REQUEST_TIMEOUT_MS = 15000;
  var sequence = 0;

  function asRecord(value) {
    return typeof value === "object" && value !== null ? value : null;
  }

  function isSnapshot(value) {
    var record = asRecord(value);
    return Boolean(
      record &&
        Object.prototype.hasOwnProperty.call(record, "data") &&
        Number.isSafeInteger(record.version) &&
        record.version >= 0 &&
        typeof record.updatedAt === "number",
    );
  }

  class GalleryPageStateError extends Error {
    constructor(message, options) {
      super(message);
      this.name = "GalleryPageStateError";
      this.code = options.code;
      this.status = options.status || 0;
      this.snapshot = options.snapshot;
    }
  }

  function requestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    sequence += 1;
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + sequence;
  }

  function request(operation) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) {
        reject(
          new GalleryPageStateError("请通过 Gallery 的 /s/<slug> 分享链接打开页面", {
            code: "not_in_preview",
          }),
        );
        return;
      }

      var id = requestId();
      var channel = new MessageChannel();
      var settled = false;

      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.close();
        callback(value);
      }

      var timer = setTimeout(function () {
        finish(
          reject,
          new GalleryPageStateError("共享数据请求超时", { code: "timeout" }),
        );
      }, REQUEST_TIMEOUT_MS);

      channel.port1.onmessage = function (event) {
        var response = asRecord(event.data);
        if (
          !response ||
          response.namespace !== NAMESPACE ||
          response.version !== PROTOCOL_VERSION ||
          response.requestId !== id
        ) {
          finish(
            reject,
            new GalleryPageStateError("共享数据桥接响应格式不正确", {
              code: "invalid_response",
            }),
          );
          return;
        }

        if (response.ok === true) {
          if (!isSnapshot(response.snapshot)) {
            finish(
              reject,
              new GalleryPageStateError("共享数据快照格式不正确", {
                code: "invalid_response",
              }),
            );
            return;
          }
          finish(resolve, response.snapshot);
          return;
        }

        var error = asRecord(response.error) || {};
        finish(
          reject,
          new GalleryPageStateError(error.message || "共享数据请求失败", {
            code: error.code || "bridge_error",
            status: error.status,
            snapshot: response.snapshot,
          }),
        );
      };
      channel.port1.onmessageerror = function () {
        finish(
          reject,
          new GalleryPageStateError("无法读取共享数据桥接响应", {
            code: "invalid_response",
          }),
        );
      };
      channel.port1.start();

      var message = Object.assign(
        {
          namespace: NAMESPACE,
          version: PROTOCOL_VERSION,
          requestId: id,
        },
        operation,
      );
      try {
        // 子文档是 opaque origin，只能用 "*"；父页面会校验 event.source 和完整协议
        window.parent.postMessage(message, "*", [channel.port2]);
      } catch {
        finish(
          reject,
          new GalleryPageStateError("无法连接共享数据桥接", {
            code: "bridge_unavailable",
          }),
        );
      }
    });
  }

  function get() {
    return request({ operation: "get" });
  }

  async function save(data, baseVersion) {
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
      throw new GalleryPageStateError("baseVersion 必须是非负安全整数", {
        code: "invalid_request",
      });
    }

    var dataJson;
    try {
      dataJson = JSON.stringify(data);
    } catch {
      throw new GalleryPageStateError("页面数据必须是可以 JSON 序列化的值", {
        code: "invalid_data",
      });
    }
    if (dataJson === undefined) {
      throw new GalleryPageStateError("页面数据不能是 undefined", {
        code: "invalid_data",
      });
    }
    return request({ operation: "save", baseVersion: baseVersion, dataJson: dataJson });
  }

  /**
   * updater 必须是无副作用的数据转换，冲突时会在最新快照上重新执行。
   * 默认最多尝试 4 次；只对明确的 version_conflict 重试，不重试网络错误。
   */
  async function update(updater, options) {
    if (typeof updater !== "function") {
      throw new GalleryPageStateError("update 需要一个数据转换函数", {
        code: "invalid_request",
      });
    }
    var requestedAttempts = options && options.maxAttempts;
    var maxAttempts = Number.isInteger(requestedAttempts)
      ? Math.max(1, Math.min(8, requestedAttempts))
      : 4;

    var snapshot = await get();
    for (var attempt = 1; ; attempt += 1) {
      var nextData = await updater(snapshot.data);
      try {
        return await save(nextData, snapshot.version);
      } catch (error) {
        if (
          !(error instanceof GalleryPageStateError) ||
          error.code !== "version_conflict" ||
          !isSnapshot(error.snapshot) ||
          attempt >= maxAttempts
        ) {
          throw error;
        }
        snapshot = error.snapshot;
      }
    }
  }

  function connect() {
    return Object.freeze({ get: get, save: save, update: update });
  }

  window.GalleryPageState = Object.freeze({
    connect: connect,
    Error: GalleryPageStateError,
    protocolVersion: PROTOCOL_VERSION,
  });
})();
