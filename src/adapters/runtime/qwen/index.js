const crypto = require("crypto");
const https = require("https");

const { SessionStore } = require("../codex/session-store");
const { normalizeModelCatalog } = require("../codex/model-catalog");
const { QwenThreadStore } = require("./thread-store");
const {
  buildTimelineSite,
  queueTimelineScreenshot,
  readTimelineSnapshot,
  writeTimelineEvents,
} = require("./timeline-tool");

function createQwenRuntimeAdapter(config) {
  const sessionStore = config.sessionStore || new SessionStore({ filePath: config.sessionsFile });
  const threadStore = new QwenThreadStore({ filePath: config.qwenRuntimeStateFile });
  const listeners = new Set();
  const activeTurnById = new Map();
  let readyState = null;

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[cyberboss] qwen event listener failed ${message}`);
      }
    }
  }

  function ensureReadyState() {
    if (!readyState) {
      readyState = {
        endpoint: resolveQwenBaseUrl(config),
        models: resolveQwenModelCatalog(config),
        hasApiKey: hasQwenApiKey(config),
      };
      if (Array.isArray(readyState.models) && readyState.models.length) {
        sessionStore.setAvailableModelCatalog("qwen", readyState.models);
      }
    }
    return readyState;
  }

  async function runTurn({
    threadId,
    workspaceRoot,
    text,
    model = "",
    turnId = crypto.randomUUID(),
    bindingKey = "",
  }) {
    const normalizedModel = normalizeText(model) || resolveDefaultQwenModel(config);
    const apiKey = resolveQwenApiKey(config);
    const baseUrl = resolveQwenBaseUrl(config);
    if (!apiKey) {
      throw new Error("Qwen runtime requires DASHSCOPE_API_KEY or CYBERBOSS_QWEN_API_KEY.");
    }

    emit({
      type: "runtime.turn.started",
      payload: {
        threadId,
        turnId,
      },
    });
    activeTurnById.set(turnId, {
      threadId,
      turnId,
      workspaceRoot,
    });

    try {
      const outputText = await completeQwenTurn({
        config,
        baseUrl,
        apiKey,
        model: normalizedModel,
        history: threadStore.getMessages(threadId),
        userText: String(text || ""),
        bindingKey,
        threadId,
      });
      threadStore.appendTurn(threadId, text, outputText);
      if (outputText) {
        emit({
          type: "runtime.reply.completed",
          payload: {
            threadId,
            turnId,
            itemId: `assistant:${turnId}`,
            text: outputText,
          },
        });
      }
      emit({
        type: "runtime.turn.completed",
        payload: {
          threadId,
          turnId,
        },
      });
      return {
        threadId,
        turnId,
        text: outputText,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Qwen request failed");
      emit({
        type: "runtime.turn.failed",
        payload: {
          threadId,
          turnId,
          text: message,
        },
      });
      throw new Error(message);
    } finally {
      activeTurnById.delete(turnId);
    }
  }

  return {
    describe() {
      return {
        id: "qwen",
        kind: "runtime",
        endpoint: resolveQwenBaseUrl(config),
        sessionsFile: config.sessionsFile,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    async initialize() {
      return ensureReadyState();
    },
    async close() {
      activeTurnById.clear();
      readyState = null;
    },
    async respondApproval() {
      throw new Error("Qwen runtime does not expose external approval requests here.");
    },
    async cancelTurn({ turnId }) {
      const activeTurn = activeTurnById.get(String(turnId || "").trim());
      if (!activeTurn) {
        return { turnId, cancelled: false };
      }
      activeTurnById.delete(String(turnId || "").trim());
      return { turnId, cancelled: true };
    },
    async resumeThread({ threadId }) {
      return { threadId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      await this.initialize();
      return runTurn({
        threadId,
        workspaceRoot,
        text: buildInstructionRefreshText(config),
        model,
        bindingKey: "",
      });
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      await this.initialize();

      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot, "qwen");
      let outboundText = text;

      if (!threadId) {
        threadId = crypto.randomUUID();
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata, "qwen");
        outboundText = buildOpeningTurnText(config, text);
      }

      await runTurn({
        threadId,
        workspaceRoot,
        text: outboundText,
        model,
        bindingKey,
      });
      return { threadId };
    },
  };
}

function resolveQwenBaseUrl(config = {}) {
  return normalizeText(config.qwenBaseUrl) || "https://dashscope.aliyuncs.com/compatible-mode/v1";
}

function resolveQwenApiKey(config = {}) {
  return normalizeText(config.qwenApiKey) || normalizeText(process.env.CYBERBOSS_QWEN_API_KEY) || normalizeText(process.env.DASHSCOPE_API_KEY);
}

function hasQwenApiKey(config = {}) {
  return !!resolveQwenApiKey(config);
}

function resolveQwenModelCatalog(config = {}) {
  const configuredModels = normalizeModelCatalog(
    Array.isArray(config.qwenModelCatalog) && config.qwenModelCatalog.length
      ? config.qwenModelCatalog.map((model) => ({ model }))
      : []
  );
  if (configuredModels.length) {
    return configuredModels;
  }
  return normalizeModelCatalog([
    { model: "qwen-plus", displayName: "Qwen Plus", isDefault: true },
    { model: "qwen-turbo", displayName: "Qwen Turbo" },
    { model: "qwen-max", displayName: "Qwen Max" },
    { model: "qwen3.5-plus", displayName: "Qwen 3.5 Plus" },
    { model: "qwen3.6-plus", displayName: "Qwen 3.6 Plus" },
    { model: "qwen3-coder-next", displayName: "Qwen 3 Coder Next" },
  ]);
}

function resolveDefaultQwenModel(config = {}) {
  const models = resolveQwenModelCatalog(config);
  return normalizeText(models.find((item) => item.isDefault)?.model)
    || normalizeText(models[0]?.model)
    || "qwen-plus";
}

function extractAssistantText(response) {
  return normalizeText(extractMessageContent(response?.choices?.[0]?.message?.content))
    || normalizeText(response?.output?.[0]?.content?.[0]?.text)
    || normalizeText(response?.output_text);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${truncateForLog(raw, 256)}`);
  }
}

function truncateForLog(value, max) {
  const text = typeof value === "string" ? value : String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function formatFetchError(error) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : null;
  const causeText = cause ? (cause instanceof Error ? cause.message : String(cause)) : "";
  return causeText && causeText !== message ? `${message} | cause=${causeText}` : message;
}

async function completeQwenTurn({
  config,
  baseUrl,
  apiKey,
  model,
  history,
  userText,
  bindingKey,
  threadId,
}) {
  const tools = buildQwenTools();
  const messages = [
    { role: "system", content: buildQwenRuntimeSystemPrompt() },
    ...normalizeHistoryMessages(history),
    { role: "user", content: String(userText || "") },
  ];

  for (let round = 0; round < 4; round += 1) {
    const parsed = await requestQwenCompletion({
      baseUrl,
      apiKey,
      model,
      messages,
      tools,
    });
    const assistantMessage = parsed?.choices?.[0]?.message || {};
    const toolCalls = extractToolCalls(assistantMessage);
    if (!toolCalls.length) {
      return extractAssistantText(parsed);
    }
    messages.push(buildAssistantToolCallMessage(assistantMessage, toolCalls));
    for (const toolCall of toolCalls) {
      const toolResult = await executeQwenToolCall(toolCall, config, {
        bindingKey,
        threadId,
      });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  throw new Error("Qwen tool loop exceeded the maximum number of rounds.");
}

async function requestQwenCompletion({ baseUrl, apiKey, model, messages, tools }) {
  const url = `${baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages,
    tools,
    tool_choice: "auto",
  });
  let response = null;
  try {
    response = await requestOverHttps(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
      timeoutMs: 40_000,
    });
  } catch (error) {
    throw new Error(`Qwen API fetch failed (${url}): ${formatFetchError(error)}`);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Qwen API ${response.statusCode}: ${truncateForLog(response.bodyText, 512)}`);
  }
  return parseJson(response.bodyText, "Qwen chat completions");
}

function buildQwenTools() {
  return [
    {
      type: "function",
      function: {
        name: "get_timeline_snapshot",
        description: "Read the local timeline-for-agent state for one day. Use this before claiming what the user did today or on a specific date.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Use YYYY-MM-DD, or today, yesterday, latest, 今天, 昨天.",
            },
            limit: {
              type: "integer",
              description: "Maximum number of events to return. Default 24.",
            },
            include_notes: {
              type: "boolean",
              description: "Whether to include event notes.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_timeline_events",
        description: "Write meaningful local timeline events for a specific day. Use for stable time blocks, not every chat message.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Required date in YYYY-MM-DD.",
            },
            events: {
              type: "array",
              description: "Events to write into the timeline.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  startAt: { type: "string" },
                  endAt: { type: "string" },
                  title: { type: "string" },
                  note: { type: "string" },
                  categoryId: { type: "string" },
                  subcategoryId: { type: "string" },
                  eventNodeId: { type: "string" },
                  tags: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["startAt", "endAt", "title"],
              },
            },
          },
          required: ["date", "events"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "build_timeline_site",
        description: "Rebuild the local timeline dashboard after timeline changes or before screenshot generation.",
        parameters: {
          type: "object",
          properties: {
            locale: {
              type: "string",
              description: "Optional locale, for example zh-CN or en.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "queue_timeline_screenshot",
        description: "Queue a timeline screenshot to be sent back to the current WeChat chat by the running bridge.",
        parameters: {
          type: "object",
          properties: {
            locale: {
              type: "string",
              description: "Optional locale, for example zh-CN or en.",
            },
            selector: {
              type: "string",
              description: "Optional screenshot selector. Default timeline.",
            },
          },
        },
      },
    },
  ];
}

function buildQwenRuntimeSystemPrompt() {
  return [
    "You are running inside Cyberboss on WeChat.",
    "If the user asks about local timeline data, what happened today, or any specific day history, call get_timeline_snapshot first.",
    "If you need to update local timeline facts, use write_timeline_events with meaningful time blocks only.",
    "If the user asks for a timeline dashboard image, build the timeline if needed and then call queue_timeline_screenshot.",
    "Do not use timeline serve or timeline dev in this runtime. They are interactive terminal commands and not suitable here.",
    "Never claim you already checked the local timeline unless you actually used the tool in this turn.",
    "If a tool fails or has no data, say that directly instead of guessing.",
    "Keep the final reply in natural WeChat Chinese, not assistant-report style.",
    "When talking about timeline data, speak like a close boyfriend on WeChat, not like a project manager, analyst, or note-taking bot.",
    "If the timeline is sparse, first summarize the existing blocks directly. Only if needed, ask at most one narrow follow-up question about one missing gap.",
    "Do not ask the user to provide keywords, rebuild the whole day, or list the main things unless the user explicitly wants to co-edit the timeline.",
    "Do not end with a homework-like prompt after you already answered the timeline request.",
  ].join(" ");
}

function normalizeHistoryMessages(history) {
  return Array.isArray(history)
    ? history
      .filter((message) => message && typeof message === "object")
      .map((message) => ({
        role: normalizeText(message.role) || "user",
        content: extractMessageContent(message.content),
      }))
      .filter((message) => message.content)
    : [];
}

function extractToolCalls(message) {
  return Array.isArray(message?.tool_calls)
    ? message.tool_calls
      .map((toolCall, index) => ({
        id: normalizeText(toolCall?.id) || `tool-call-${index + 1}`,
        name: normalizeText(toolCall?.function?.name),
        arguments: normalizeToolArguments(toolCall?.function?.arguments),
      }))
      .filter((toolCall) => toolCall.name)
    : [];
}

function buildAssistantToolCallMessage(message, toolCalls) {
  return {
    role: "assistant",
    content: extractMessageContent(message?.content),
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments || "{}",
      },
    })),
  };
}

async function executeQwenToolCall(toolCall, config, context = {}) {
  try {
    const args = parseToolArguments(toolCall.arguments);
    if (toolCall.name === "get_timeline_snapshot") {
      return readTimelineSnapshot(config, args);
    }
    if (toolCall.name === "write_timeline_events") {
      return writeTimelineEvents(config, args);
    }
    if (toolCall.name === "build_timeline_site") {
      return buildTimelineSite(config, args);
    }
    if (toolCall.name === "queue_timeline_screenshot") {
      return queueTimelineScreenshot(config, {
        ...args,
        ...context,
      });
    }
    return {
      ok: false,
      error: `unsupported tool: ${toolCall.name}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error || "tool execution failed"),
    };
  }
}

function parseToolArguments(raw) {
  const text = normalizeText(raw);
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error(`invalid tool arguments: ${truncateForLog(text, 160)}`);
  }
}

function normalizeToolArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return JSON.stringify(raw);
  }
  const text = normalizeText(raw);
  if (!text) {
    return "{}";
  }
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return JSON.stringify({ raw: text });
  }
}

function extractMessageContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "text") {
        return String(part.text || "");
      }
      return "";
    })
    .join("\n")
    .trim();
}

function requestOverHttps(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers,
      timeout: timeoutMs,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: Number(response.statusCode || 0),
          bodyText: raw,
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function buildOpeningTurnText(config, userText) {
  const { buildOpeningTurnText: buildCodexOpeningTurnText } = require("../codex");
  return buildCodexOpeningTurnText(config, userText);
}

function buildInstructionRefreshText(config) {
  const { buildInstructionRefreshText: buildCodexInstructionRefreshText } = require("../codex");
  return buildCodexInstructionRefreshText(config);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createQwenRuntimeAdapter,
  resolveQwenApiKey,
  resolveQwenBaseUrl,
  resolveQwenModelCatalog,
  buildQwenTools,
  normalizeToolArguments,
};
