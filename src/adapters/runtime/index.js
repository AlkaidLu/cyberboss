const { createCodexRuntimeAdapter } = require("./codex");
const { createClaudeCodeRuntimeAdapter } = require("./claude-code");
const { createQwenRuntimeAdapter } = require("./qwen");
const { normalizeRuntimeId } = require("./codex/session-store");

function createRuntimeAdapter(config, runtimeId = "") {
  const runtime = normalizeRuntimeId(runtimeId || config?.runtime);
  if (!runtime || runtime === "codex") {
    return createCodexRuntimeAdapter({
      ...config,
      runtime: "codex",
    });
  }
  if (runtime === "claude-code") {
    return createClaudeCodeRuntimeAdapter({
      ...config,
      runtime: "claude-code",
      runtimeKey: "claude-code",
    });
  }
  if (runtime === "aliyun") {
    return createClaudeCodeRuntimeAdapter({
      ...config,
      runtime: "aliyun",
      runtimeKey: "aliyun",
      claudeCommand: config.aliyunClaudeCommand || config.claudeCommand,
      claudePermissionMode: config.aliyunClaudePermissionMode || config.claudePermissionMode,
      claudeArgs: Array.isArray(config.aliyunClaudeArgs) && config.aliyunClaudeArgs.length
        ? config.aliyunClaudeArgs
        : config.claudeArgs,
      claudeModelCatalog: Array.isArray(config.aliyunClaudeModelCatalog) && config.aliyunClaudeModelCatalog.length
        ? config.aliyunClaudeModelCatalog
        : config.claudeModelCatalog,
      runtimeEnv: {
        ANTHROPIC_API_KEY: config.aliyunAnthropicApiKey,
        ANTHROPIC_BASE_URL: config.aliyunAnthropicBaseUrl || "https://dashscope.aliyuncs.com/apps/anthropic",
      },
    });
  }
  if (runtime === "qwen") {
    return createQwenRuntimeAdapter({
      ...config,
      runtime: "qwen",
      runtimeKey: "qwen",
    });
  }
  throw new Error(`Unsupported runtime: ${runtimeId || config?.runtime || "(empty)"}`);
}

function createRuntimeAdapterMap(config) {
  return {
    codex: createRuntimeAdapter(config, "codex"),
    "claude-code": createRuntimeAdapter(config, "claude-code"),
    aliyun: createRuntimeAdapter(config, "aliyun"),
    qwen: createRuntimeAdapter(config, "qwen"),
  };
}

function listSupportedRuntimeIds() {
  return ["codex", "claude-code", "aliyun", "qwen"];
}

module.exports = {
  createRuntimeAdapter,
  createRuntimeAdapterMap,
  listSupportedRuntimeIds,
  normalizeRuntimeId,
};
