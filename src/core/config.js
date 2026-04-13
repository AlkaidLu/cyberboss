const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot: readTextEnv("CYBERBOSS_WORKSPACE_ROOT") || process.cwd(),
    userName: readTextEnv("CYBERBOSS_USER_NAME") || "User",
    userGender: readTextEnv("CYBERBOSS_USER_GENDER") || "female",
    allowedUserIds: readListEnv("CYBERBOSS_ALLOWED_USER_IDS"),
    channel: readTextEnv("CYBERBOSS_CHANNEL") || "weixin",
    runtime: readTextEnv("CYBERBOSS_RUNTIME") || "codex",
    timelineCommand: readTextEnv("CYBERBOSS_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinAdapterVariant: readTextEnv("CYBERBOSS_WEIXIN_ADAPTER") || "v2",
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.resolve(__dirname, "..", "..", "templates", "weixin-operations.md"),
    diaryDir: path.join(stateDir, "diary"),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("CYBERBOSS_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("CYBERBOSS_CODEX_COMMAND"),
    codexAccessMode: readTextEnv("CYBERBOSS_CODEX_ACCESS_MODE"),
    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND"),
    claudePermissionMode: readTextEnv("CYBERBOSS_CLAUDE_PERMISSION_MODE"),
    claudeArgs: readListEnv("CYBERBOSS_CLAUDE_ARGS"),
    claudeModelCatalog: readListEnv("CYBERBOSS_CLAUDE_MODEL_CATALOG"),
    aliyunClaudeCommand: readTextEnv("CYBERBOSS_ALIYUN_CLAUDE_COMMAND"),
    aliyunAnthropicApiKey: readTextEnv("CYBERBOSS_ALIYUN_ANTHROPIC_API_KEY"),
    aliyunAnthropicBaseUrl: readTextEnv("CYBERBOSS_ALIYUN_ANTHROPIC_BASE_URL"),
    aliyunClaudePermissionMode: readTextEnv("CYBERBOSS_ALIYUN_CLAUDE_PERMISSION_MODE"),
    aliyunClaudeArgs: readListEnv("CYBERBOSS_ALIYUN_CLAUDE_ARGS"),
    aliyunClaudeModelCatalog: readListEnv("CYBERBOSS_ALIYUN_CLAUDE_MODEL_CATALOG"),
    qwenApiKey: readTextEnv("CYBERBOSS_QWEN_API_KEY") || readTextEnv("DASHSCOPE_API_KEY"),
    qwenBaseUrl: readTextEnv("CYBERBOSS_QWEN_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    qwenModelCatalog: readListEnv("CYBERBOSS_QWEN_MODEL_CATALOG"),
    qwenRuntimeStateFile: path.join(stateDir, "qwen-runtime-state.json"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

module.exports = { readConfig };
