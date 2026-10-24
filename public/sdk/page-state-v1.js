/* Gallery 桥接 SDK v1。经典 <script> 引入，无依赖。
 *
 * 推荐入口：window.Gallery（getCapabilities / pageState / visitorState / db / llm）。
 * 旧全局变量继续保留，已有页面无需迁移：
 *   window.GalleryPageState    —— 整页共享 JSON（get/save/update）
 *   window.GalleryVisitorState —— 每访客私有 JSON（get/save/update）
 *   window.GalleryDB           —— 行级共享数据（collection().get/put/update/del/list）
 *   window.GalleryLLM          —— 页面内 LLM（ask(prompt, {context?})）
 *
 * 桥接：子页面 postMessage → 父页面 → /api/{page-state,visitor-state,kv,llm}/<slug>。
 * page-state / visitor-state 用 snapshot 协议字段；capabilities / kv / llm 用 result 字段。
 */
(function () {
  "use strict";

  var NAMESPACE = "gallery-page-state";
  var PROTOCOL_VERSION = 1;
  var REQUEST_TIMEOUT_MS = 30000;
  var sequence = 0;
  var requiredDataSchemaVersion;
  var EVENT_TYPES = ["page-state", "kv", "comments", "version", "attachments", "reset"];

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

  class GalleryStateError extends Error {
    constructor(message, options) {
      super(message);
      this.name = "GalleryStateError";
      this.code = options.code;
      this.status = options.status || 0;
      this.snapshot = options.snapshot;
      this.result = options.result;
    }
  }

  function requestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    sequence += 1;
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + sequence;
  }

  /**
   * 统一 postMessage 通道。
   * expect 决定响应校验方式："snapshot"（page/visitor）或 "result"（kv/llm）。
   */
  function request(operation, expect) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) {
        reject(
          new GalleryStateError("请通过 Gallery 的 /s/<slug> 分享链接打开页面", {
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
        finish(reject, new GalleryStateError("请求超时", { code: "timeout" }));
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
            new GalleryStateError("桥接响应格式不正确", { code: "invalid_response" }),
          );
          return;
        }

        if (response.ok === true) {
          if (expect === "snapshot") {
            if (!isSnapshot(response.snapshot)) {
              finish(
                reject,
                new GalleryStateError("快照格式不正确", { code: "invalid_response" }),
              );
              return;
            }
            finish(resolve, response.snapshot);
          } else {
            finish(resolve, response.result);
          }
          return;
        }

        var error = asRecord(response.error) || {};
        finish(
          reject,
          new GalleryStateError(error.message || "请求失败", {
            code: error.code || "bridge_error",
            status: error.status,
            snapshot: response.snapshot,
            result: response.result === undefined ? response.snapshot : response.result,
          }),
        );
      };
      channel.port1.onmessageerror = function () {
        finish(
          reject,
          new GalleryStateError("无法读取桥接响应", { code: "invalid_response" }),
        );
      };
      channel.port1.start();

      var message = Object.assign(
        {
          namespace: NAMESPACE,
          version: PROTOCOL_VERSION,
          requestId: id,
          schemaVersion: requiredDataSchemaVersion,
        },
        operation,
      );
      try {
        window.parent.postMessage(message, "*", [channel.port2]);
      } catch {
        finish(
          reject,
          new GalleryStateError("无法连接桥接", { code: "bridge_unavailable" }),
        );
      }
    });
  }

  function streamChatRequest(payload, onDelta, signal) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) {
        reject(new GalleryStateError("请通过 Gallery 的分享预览打开页面", { code: "not_in_preview" }));
        return;
      }
      var id = requestId();
      var channel = new MessageChannel();
      var settled = false;
      var timer = setTimeout(function () {
        finish(reject, new GalleryStateError("生成超时", { code: "timeout" }));
      }, 120000);
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.close();
        if (signal) signal.removeEventListener("abort", onAbort);
        callback(value);
      }
      function onAbort() {
        request({ operation: "llm-cancel", targetRequestId: id }, "result").catch(function () {});
        finish(reject, new GalleryStateError("已取消生成", { code: "aborted" }));
      }
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      channel.port1.onmessage = function (message) {
        var response = asRecord(message.data);
        if (!response || response.namespace !== NAMESPACE || response.version !== PROTOCOL_VERSION || response.requestId !== id) return;
        if (typeof response.delta === "string") {
          if (onDelta) onDelta(response.delta);
          return;
        }
        if (response.ok === true) { finish(resolve, response.result); return; }
        var error = asRecord(response.error) || {};
        finish(reject, new GalleryStateError(error.message || "生成失败", {
          code: error.code || "upstream_error",
          status: error.status,
        }));
      };
      channel.port1.onmessageerror = function () {
        finish(reject, new GalleryStateError("无法读取 LLM 桥接响应", { code: "invalid_response" }));
      };
      channel.port1.start();
      try {
        window.parent.postMessage(Object.assign({
          namespace: NAMESPACE,
          version: PROTOCOL_VERSION,
          requestId: id,
          schemaVersion: requiredDataSchemaVersion,
          operation: "llm-chat",
        }, payload), "*", [channel.port2]);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function abortableDelay(ms, signal) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(done, ms);
      function done() {
        if (signal) signal.removeEventListener("abort", aborted);
        resolve();
      }
      function aborted() {
        clearTimeout(timer);
        reject(new GalleryStateError("已取消生成", { code: "aborted" }));
      }
      if (signal) {
        if (signal.aborted) { aborted(); return; }
        signal.addEventListener("abort", aborted, { once: true });
      }
    });
  }

  async function chat(options) {
    options = options || {};
    var messages = Array.isArray(options.messages) ? options.messages.slice() : [];
    if (options.prompt) messages.push({ role: "user", content: options.prompt });
    if (!messages.length) throw new GalleryStateError("chat 需要 prompt 或 messages", { code: "invalid_request" });
    var tools = Array.isArray(options.tools) ? options.tools : [];
    var retries = Number.isInteger(options.retries) ? Math.max(0, Math.min(3, options.retries)) : 0;
    for (var round = 0; round < 6; round += 1) {
      var result;
      for (var attempt = 0; ; attempt += 1) {
        try {
          result = await streamChatRequest({
            messages: messages,
            context: options.context,
            responseSchema: options.responseSchema,
            tools: tools.map(function (tool) {
              return { name: tool.name, description: tool.description, parameters: tool.parameters };
            }),
          }, options.onDelta, options.signal);
          break;
        } catch (error) {
          var retryable = error instanceof GalleryStateError &&
            (error.code === "upstream_error" || error.code === "timeout" || error.status >= 500);
          if (!retryable || attempt >= retries) throw error;
          await abortableDelay(250 * Math.pow(2, attempt), options.signal);
        }
      }
      var record = asRecord(result);
      if (!record || typeof record.text !== "string") {
        throw new GalleryStateError("LLM 响应格式不正确", { code: "invalid_response" });
      }
      var calls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
      if (!calls.length) {
        if (options.responseSchema) {
          try { record.json = JSON.parse(record.text); }
          catch { throw new GalleryStateError("模型没有返回合法 JSON", { code: "invalid_structured_output" }); }
        }
        return record;
      }
      messages.push({ role: "assistant", content: record.text, toolCalls: calls });
      for (var index = 0; index < calls.length; index += 1) {
        var call = calls[index];
        var tool = tools.find(function (candidate) { return candidate.name === call.name; });
        if (!tool || typeof tool.execute !== "function") {
          throw new GalleryStateError("模型请求了未注册的工具：" + call.name, { code: "unknown_tool" });
        }
        var output = await tool.execute(call.arguments, { signal: options.signal, id: call.id, name: call.name });
        var content;
        try { content = JSON.stringify(output === undefined ? null : output); }
        catch { content = String(output); }
        messages.push({ role: "tool", toolCallId: call.id, content: content });
      }
    }
    throw new GalleryStateError("工具调用轮次过多", { code: "tool_round_limit" });
  }

  function makeJsonStateOps(opGet, opSave) {
    function get() {
      return request({ operation: opGet }, "snapshot");
    }
    async function save(data, baseVersion) {
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
        throw new GalleryStateError("baseVersion 必须是非负安全整数", {
          code: "invalid_request",
        });
      }
      var dataJson;
      try {
        dataJson = JSON.stringify(data);
      } catch {
        throw new GalleryStateError("数据必须是可 JSON 序列化的值", {
          code: "invalid_data",
        });
      }
      if (dataJson === undefined) {
        throw new GalleryStateError("数据不能是 undefined", { code: "invalid_data" });
      }
      return request(
        { operation: opSave, baseVersion: baseVersion, dataJson: dataJson },
        "snapshot",
      );
    }
    async function update(updater, options) {
      if (typeof updater !== "function") {
        throw new GalleryStateError("update 需要一个函数", { code: "invalid_request" });
      }
      var maxAttempts = Number.isInteger(options && options.maxAttempts)
        ? Math.max(1, Math.min(8, options.maxAttempts))
        : 4;
      var snapshot = await get();
      for (var attempt = 1; ; attempt += 1) {
        var nextData = await updater(snapshot.data);
        try {
          return await save(nextData, snapshot.version);
        } catch (error) {
          if (
            !(error instanceof GalleryStateError) ||
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
    return { get: get, save: save, update: update };
  }

  var pageOps = makeJsonStateOps("get", "save");
  var visitorOps = makeJsonStateOps("visitor-get", "visitor-save");

  // —— KV：collection(key) 行集 ——
  function kvCollection(collection) {
    function get(key) {
      return request(
        { operation: "kv-get", collection: collection, key: key },
        "result",
      );
    }
    function list(options) {
      return request(
        {
          operation: "kv-list",
          collection: collection,
          prefix: options && options.prefix,
          cursor: options && options.cursor,
          limit: options && options.limit,
        },
        "result",
      );
    }
    async function put(key, value, options) {
      var valueJson;
      try {
        valueJson = JSON.stringify(value === undefined ? null : value);
      } catch {
        throw new GalleryStateError("值必须可 JSON 序列化", { code: "invalid_data" });
      }
      var op = {
        operation: "kv-put",
        collection: collection,
        valueJson: valueJson,
        baseVersion: options && options.baseVersion,
        ifAbsent: options && options.ifAbsent,
      };
      if (key !== undefined) op.key = key;
      return request(op, "result");
    }
    async function del(key, options) {
      return request(
        {
          operation: "kv-del",
          collection: collection,
          key: key,
          baseVersion: options && options.baseVersion,
        },
        "result",
      );
    }
    async function update(key, updater, options) {
      if (typeof updater !== "function") {
        throw new GalleryStateError("update 需要一个函数", { code: "invalid_request" });
      }
      var maxAttempts = Number.isInteger(options && options.maxAttempts)
        ? Math.max(1, Math.min(8, options.maxAttempts))
        : 4;
      var item = await get(key);
      for (var attempt = 1; ; attempt += 1) {
        var next = await updater(item ? item.value : null, item);
        try {
          return await put(key, next, { baseVersion: item ? item.version : 0 });
        } catch (error) {
          if (
            !(error instanceof GalleryStateError) ||
            error.code !== "version_conflict" ||
            !error.result ||
            attempt >= maxAttempts
          ) {
            throw error;
          }
          item = error.result;
        }
      }
    }
    return Object.freeze({
      get: get,
      list: list,
      put: put,
      del: del,
      update: update,
    });
  }

  function requireDataSchema(version) {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new GalleryStateError("schemaVersion 必须是正安全整数", {
        code: "invalid_request",
      });
    }
    requiredDataSchemaVersion = version;
    return version;
  }

  function subscribe(listener, options) {
    return new Promise(function (resolve, reject) {
      if (typeof listener !== "function") {
        reject(new GalleryStateError("subscribe 需要一个回调函数", { code: "invalid_request" }));
        return;
      }
      if (window.parent === window) {
        reject(new GalleryStateError("请通过 Gallery 的分享预览打开页面", { code: "not_in_preview" }));
        return;
      }
      var types = options && options.types;
      if (
        types !== undefined &&
        (!Array.isArray(types) || types.length > EVENT_TYPES.length ||
          types.some(function (type) { return EVENT_TYPES.indexOf(type) === -1; }))
      ) {
        reject(new GalleryStateError("事件类型不正确", { code: "invalid_request" }));
        return;
      }

      var id = requestId();
      var channel = new MessageChannel();
      var ready = false;
      var closed = false;
      var timer = setTimeout(function () {
        close();
        reject(new GalleryStateError("订阅超时", { code: "timeout" }));
      }, REQUEST_TIMEOUT_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        channel.port1.close();
      }

      channel.port1.onmessage = function (message) {
        var data = asRecord(message.data);
        if (!data || data.namespace !== NAMESPACE || data.version !== PROTOCOL_VERSION) return;
        if (data.requestId === id) {
          if (data.ok === true) {
            ready = true;
            clearTimeout(timer);
            resolve(function unsubscribe() {
              if (closed) return Promise.resolve({ unsubscribed: false });
              close();
              return request(
                { operation: "unsubscribe", subscriptionId: id },
                "result",
              );
            });
          } else {
            var error = asRecord(data.error) || {};
            close();
            reject(new GalleryStateError(error.message || "订阅失败", {
              code: error.code || "bridge_error",
              status: error.status,
            }));
          }
          return;
        }
        var event = asRecord(data.event);
        if (
          ready &&
          event &&
          Number.isSafeInteger(event.id) &&
          EVENT_TYPES.indexOf(event.type) !== -1
        ) {
          listener(Object.freeze(event));
        }
      };
      channel.port1.onmessageerror = function () {
        if (ready) return;
        close();
        reject(new GalleryStateError("无法读取桥接响应", { code: "invalid_response" }));
      };
      channel.port1.start();
      try {
        window.parent.postMessage(
          {
            namespace: NAMESPACE,
            version: PROTOCOL_VERSION,
            requestId: id,
            operation: "subscribe",
            types: types,
          },
          "*",
          [channel.port2],
        );
      } catch (error) {
        close();
        reject(error);
      }
    });
  }

  var attachmentFiles = Object.freeze({
    list: function () {
      return request({ operation: "attachment-list" }, "result");
    },
    upload: function (file, options) {
      if (typeof Blob === "undefined" || !(file instanceof Blob)) {
        return Promise.reject(new GalleryStateError("upload 需要 File 或 Blob", { code: "invalid_request" }));
      }
      return request({
        operation: "attachment-upload",
        name: (options && options.name) || file.name || "attachment",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        visibility: options && options.visibility === "shared" ? "shared" : "private",
        data: file,
      }, "result");
    },
    download: function (attachmentId) {
      return request({ operation: "attachment-download", attachmentId: attachmentId }, "result")
        .then(function (result) {
          var record = asRecord(result);
          if (!record || !(record.data instanceof ArrayBuffer)) {
            throw new GalleryStateError("附件响应格式不正确", { code: "invalid_response" });
          }
          return new Blob([record.data], {
            type: typeof record.mimeType === "string" ? record.mimeType : undefined,
          });
        });
    },
    delete: function (attachmentId) {
      return request({ operation: "attachment-delete", attachmentId: attachmentId }, "result");
    },
  });

  function getCapabilities() {
    return request({ operation: "capabilities" }, "result").then(function (value) {
      var capabilities = asRecord(value);
      if (
        !capabilities ||
        capabilities.protocolVersion !== PROTOCOL_VERSION ||
        typeof capabilities.pageState !== "boolean" ||
        typeof capabilities.visitorState !== "boolean" ||
        typeof capabilities.kv !== "boolean" ||
        typeof capabilities.attachments !== "boolean" ||
        typeof capabilities.llm !== "boolean" ||
        !Number.isSafeInteger(capabilities.dataGeneration) ||
        !Number.isSafeInteger(capabilities.dataSchemaVersion)
      ) {
        throw new GalleryStateError("能力信息格式不正确", { code: "invalid_response" });
      }
      return Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        pageState: capabilities.pageState,
        visitorState: capabilities.visitorState,
        kv: capabilities.kv,
        attachments: capabilities.attachments,
        llm: capabilities.llm,
        dataGeneration: capabilities.dataGeneration,
        dataSchemaVersion: capabilities.dataSchemaVersion,
      });
    });
  }

  window.GalleryPageState = Object.freeze({
    connect: function () {
      return Object.freeze({ get: pageOps.get, save: pageOps.save, update: pageOps.update });
    },
    Error: GalleryStateError,
    protocolVersion: PROTOCOL_VERSION,
  });
  window.GalleryVisitorState = Object.freeze({
    connect: function () {
      return Object.freeze({
        get: visitorOps.get,
        save: visitorOps.save,
        update: visitorOps.update,
      });
    },
    Error: GalleryStateError,
    protocolVersion: PROTOCOL_VERSION,
  });
  window.GalleryDB = Object.freeze({
    collection: kvCollection,
    Error: GalleryStateError,
    protocolVersion: PROTOCOL_VERSION,
  });
  window.GalleryLLM = Object.freeze({
    chat: chat,
    ask: function (prompt, options) {
      if (typeof prompt !== "string" || !prompt) {
        return Promise.reject(
          new GalleryStateError("ask 需要非空 prompt", { code: "invalid_request" }),
        );
      }
      return request(
        {
          operation: "llm-ask",
          prompt: prompt,
          context:
            options && typeof options.context === "string" ? options.context : undefined,
        },
        "result",
      ).then(function (r) {
        return asRecord(r) || {};
      });
    },
    Error: GalleryStateError,
    protocolVersion: PROTOCOL_VERSION,
  });

  // 统一入口。旧全局变量是兼容别名，二者使用完全相同的桥接与错误类型。
  window.Gallery = Object.freeze({
    getCapabilities: getCapabilities,
    requireDataSchema: requireDataSchema,
    events: Object.freeze({ subscribe: subscribe }),
    pageState: window.GalleryPageState,
    visitorState: window.GalleryVisitorState,
    db: window.GalleryDB,
    files: attachmentFiles,
    llm: window.GalleryLLM,
    Error: GalleryStateError,
    protocolVersion: PROTOCOL_VERSION,
  });
})();
