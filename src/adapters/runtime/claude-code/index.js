const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { SessionStore } = require("../codex/session-store");
const { normalizeModelCatalog } = require("../codex/model-catalog");

function createClaudeCodeRuntimeAdapter(config) {
  const sessionStore = config.sessionStore || new SessionStore({ filePath: config.sessionsFile });
  const listeners = new Set();
  const activeTurnById = new Map();
  let readyState = null;
  const runtimeKey = normalizeRuntimeKey(config.runtimeKey || config.runtime || "claude-code");
  const runtimeEnv = buildRuntimeEnv(config);

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[cyberboss] claude-code event listener failed ${message}`);
      }
    }
  }

  function ensureClaudeAvailable() {
    const command = resolveClaudeCommand(config);
    const invocation = buildProcessInvocation(command, ["--version"]);
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: runtimeEnv,
      shell: false,
    });
    if (result.error) {
      throw new Error(
        `Unable to start Claude Code CLI with "${command}". ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      throw new Error(
        `Claude Code CLI check failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`
      );
    }
    return {
      endpoint: command,
      models: resolveClaudeModelCatalog(config),
    };
  }

  async function runTurn({
    threadId,
    workspaceRoot,
    text,
    model = "",
    turnId = crypto.randomUUID(),
    resume = false,
  }) {
    const command = resolveClaudeCommand(config);
    const args = buildClaudeCommandArgs({
      prompt: text,
      threadId,
      model,
      resume,
      permissionMode: config.claudePermissionMode,
      additionalArgs: config.claudeArgs,
    });
    const invocation = buildProcessInvocation(command, args);

    emit({
      type: "runtime.turn.started",
      payload: {
        threadId,
        turnId,
      },
    });

    const child = spawn(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      env: runtimeEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    activeTurnById.set(turnId, child);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    return new Promise((resolve, reject) => {
      child.on("error", (error) => {
        activeTurnById.delete(turnId);
        emit({
          type: "runtime.turn.failed",
          payload: {
            threadId,
            turnId,
            text: error.message,
          },
        });
        reject(error);
      });

      child.on("close", (code, signal) => {
        activeTurnById.delete(turnId);
        const parsed = parseClaudeJsonOutput(stdout);
        const outputText = parsed.text;
        const resolvedThreadId = parsed.sessionId || threadId;
        if (code === 0) {
          if (outputText) {
            emit({
              type: "runtime.reply.completed",
              payload: {
                threadId: resolvedThreadId,
                turnId,
                itemId: `assistant:${turnId}`,
                text: outputText,
              },
            });
          }
          emit({
            type: "runtime.turn.completed",
            payload: {
              threadId: resolvedThreadId,
              turnId,
            },
          });
          resolve({
            threadId: resolvedThreadId,
            turnId,
            text: outputText,
          });
          return;
        }

        const failureText = [
          signal ? `signal=${signal}` : "",
          String(stderr || "").trim(),
          String(stdout || "").trim(),
          `exit=${code}`,
        ].filter(Boolean).join("\n");
        emit({
          type: "runtime.turn.failed",
          payload: {
            threadId,
            turnId,
            text: failureText || "Claude Code request failed",
          },
        });
        reject(new Error(failureText || "Claude Code request failed"));
      });
    });
  }

  return {
    describe() {
      return {
        id: "claude-code",
        runtimeKey,
        kind: "runtime",
        endpoint: resolveClaudeCommand(config),
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
      if (!readyState) {
        readyState = ensureClaudeAvailable();
        if (Array.isArray(readyState.models) && readyState.models.length) {
          sessionStore.setAvailableModelCatalog(runtimeKey, readyState.models);
        }
      }
      return readyState;
    },
    async close() {
      for (const child of activeTurnById.values()) {
        child.kill();
      }
      activeTurnById.clear();
      readyState = null;
    },
    async respondApproval() {
      throw new Error(
        "Claude Code runtime does not expose external approval requests here. Set CYBERBOSS_CLAUDE_PERMISSION_MODE instead."
      );
    },
    async cancelTurn({ turnId }) {
      const child = activeTurnById.get(String(turnId || "").trim());
      if (!child) {
        return { turnId, cancelled: false };
      }
      child.kill();
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
        resume: true,
      });
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      await this.initialize();

      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeKey);
      let outboundText = text;
      let resume = true;
      let createdThread = false;

      if (!threadId) {
        threadId = crypto.randomUUID();
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata, runtimeKey);
        outboundText = buildOpeningTurnText(config, text);
        resume = false;
        createdThread = true;
      }

      try {
        const result = await runTurn({
          threadId,
          workspaceRoot,
          text: outboundText,
          model,
          resume,
        });
        if (createdThread && result.threadId && result.threadId !== threadId) {
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, result.threadId, metadata, runtimeKey);
          threadId = result.threadId;
        }
      } catch (error) {
        if (resume) {
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeKey);
        }
        throw error;
      }

      return { threadId };
    },
  };
}

function buildClaudeCommandArgs({
  prompt,
  threadId,
  model = "",
  resume = false,
  permissionMode = "",
  additionalArgs = [],
}) {
  const args = [];
  const normalizedModel = normalizeText(model);
  const normalizedThreadId = normalizeText(threadId);
  const normalizedPermissionMode = normalizeText(permissionMode);

  if (resume) {
    args.push("--resume", normalizedThreadId);
  } else if (normalizedThreadId) {
    args.push("--session-id", normalizedThreadId);
  }
  if (normalizedModel) {
    args.push("--model", normalizedModel);
  }
  if (normalizedPermissionMode) {
    args.push("--permission-mode", normalizedPermissionMode);
  }
  const normalizedAdditionalArgs = normalizeAdditionalArgs(additionalArgs);
  if (normalizedAdditionalArgs.length) {
    args.push(...normalizedAdditionalArgs);
  }
  args.push("-p", String(prompt || ""), "--output-format", "json");
  return args;
}

function parseClaudeJsonOutput(stdout) {
  const normalized = String(stdout || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      text: "",
      sessionId: "",
    };
  }
  try {
    const parsed = JSON.parse(normalized);
    return {
      text: normalizeText(parsed?.result || parsed?.text || ""),
      sessionId: normalizeText(parsed?.session_id || parsed?.sessionId || ""),
    };
  } catch {
    return {
      text: normalized,
      sessionId: "",
    };
  }
}

function resolveClaudeCommand(config = {}) {
  return normalizeText(config.claudeCommand) || "claude";
}

function buildProcessInvocation(command, args = []) {
  const normalizedCommand = normalizeText(command);
  const normalizedArgs = Array.isArray(args)
    ? args.map((item) => String(item || "")).filter((item) => item.length > 0)
    : [];
  const directClaudeCliInvocation = resolveDirectClaudeCliInvocation(normalizedCommand, normalizedArgs);
  if (directClaudeCliInvocation) {
    return directClaudeCliInvocation;
  }
  if (process.platform === "win32" && /\.cmd$/i.test(normalizedCommand)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/c", normalizedCommand, ...normalizedArgs],
    };
  }
  return {
    command: normalizedCommand,
    args: normalizedArgs,
  };
}

function normalizeAdditionalArgs(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const raw = String(value || "").trim();
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
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

function resolveDirectClaudeCliInvocation(command, args) {
  if (process.platform !== "win32") {
    return null;
  }
  const shimPath = resolveWindowsClaudeShimPath(command);
  if (!shimPath) {
    return null;
  }
  const shimDir = path.dirname(shimPath);
  const cliPath = path.join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (!fs.existsSync(cliPath)) {
    return null;
  }
  const bundledNode = path.join(shimDir, "node.exe");
  const nodeCommand = fs.existsSync(bundledNode) ? bundledNode : process.execPath;
  return {
    command: nodeCommand,
    args: [cliPath, ...args],
  };
}

function resolveWindowsClaudeShimPath(command) {
  const normalizedCommand = normalizeText(command);
  if (!normalizedCommand) {
    return "";
  }
  if (isLikelyPath(normalizedCommand)) {
    return looksLikeClaudeShim(normalizedCommand) && fs.existsSync(normalizedCommand)
      ? path.resolve(normalizedCommand)
      : "";
  }

  const lookup = spawnSync("where.exe", [normalizedCommand], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    env: process.env,
    shell: false,
  });
  if (lookup.error || lookup.status !== 0) {
    return "";
  }
  const candidates = String(lookup.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matched = candidates.find((candidate) => looksLikeClaudeShim(candidate) && fs.existsSync(candidate));
  return matched ? path.resolve(matched) : "";
}

function looksLikeClaudeShim(targetPath) {
  const basename = path.basename(String(targetPath || "")).toLowerCase();
  return basename === "claude" || basename === "claude.cmd";
}

function isLikelyPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value)
    || value.startsWith(".\\")
    || value.startsWith("..\\")
    || value.startsWith("\\\\")
    || value.includes("\\")
    || value.includes("/");
}

function resolveClaudeModelCatalog(config = {}) {
  const configuredModels = normalizeModelCatalog(
    Array.isArray(config.claudeModelCatalog)
      ? config.claudeModelCatalog.map((model) => ({ model }))
      : []
  );
  if (configuredModels.length) {
    return configuredModels;
  }
  const runtimeBaseUrl = normalizeText(config.runtimeEnv?.ANTHROPIC_BASE_URL)
    || normalizeText(config.anthropicBaseUrl)
    || "";
  if (isDashScopeAnthropicBaseUrl(runtimeBaseUrl)) {
    return normalizeModelCatalog([
      { model: "qwen3.6-plus", displayName: "Qwen 3.6 Plus", isDefault: true },
      { model: "qwen3.5-plus", displayName: "Qwen 3.5 Plus" },
      { model: "qwen-plus", displayName: "Qwen Plus" },
      { model: "qwen3.5-flash", displayName: "Qwen 3.5 Flash" },
      { model: "qwen-flash", displayName: "Qwen Flash" },
      { model: "qwen-turbo", displayName: "Qwen Turbo" },
      { model: "qwen3-coder-next", displayName: "Qwen 3 Coder Next" },
      { model: "qwen3-coder-plus", displayName: "Qwen 3 Coder Plus" },
      { model: "qwen3-coder-flash", displayName: "Qwen 3 Coder Flash" },
      { model: "qwen3-max", displayName: "Qwen 3 Max" },
    ]);
  }
  return normalizeModelCatalog([
    { model: "sonnet", displayName: "Sonnet", isDefault: true },
    { model: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    { model: "opus", displayName: "Opus" },
  ]);
}

function buildRuntimeEnv(config = {}) {
  const env = {
    ...process.env,
  };
  if (config.runtimeEnv && typeof config.runtimeEnv === "object") {
    for (const [key, value] of Object.entries(config.runtimeEnv)) {
      if (!key) {
        continue;
      }
      const normalizedValue = typeof value === "string" ? value.trim() : "";
      if (normalizedValue) {
        env[key] = normalizedValue;
      } else {
        delete env[key];
      }
    }
  }
  return env;
}

function normalizeRuntimeKey(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || "claude-code";
}

function isDashScopeAnthropicBaseUrl(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized.includes("dashscope.aliyuncs.com/apps/anthropic")
    || normalized.includes("dashscope-intl.aliyuncs.com/apps/anthropic")
    || normalized.includes("dashscope-us.aliyuncs.com/apps/anthropic");
}

module.exports = {
  createClaudeCodeRuntimeAdapter,
  buildClaudeCommandArgs,
  buildProcessInvocation,
  parseClaudeJsonOutput,
  resolveClaudeModelCatalog,
  buildRuntimeEnv,
};
