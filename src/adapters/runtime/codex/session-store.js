const fs = require("fs");
const path = require("path");
const { normalizeModelCatalog } = require("./model-catalog");

class SessionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.bindings) {
        this.state = {
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings || {},
          approvalCommandAllowlistByWorkspaceRoot: parsed.approvalCommandAllowlistByWorkspaceRoot || {},
          approvalPromptStateByThreadId: parsed.approvalPromptStateByThreadId || {},
          availableModelCatalogByRuntime: parsed.availableModelCatalogByRuntime || {},
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  listBindings() {
    return Object.entries(this.state.bindings || {}).map(([bindingKey, binding]) => ({
      bindingKey,
      ...(binding || {}),
    }));
  }

  getActiveWorkspaceRoot(bindingKey) {
    return normalizeValue(this.state.bindings[bindingKey]?.activeWorkspaceRoot);
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...(this.state.bindings[bindingKey] || {}),
      ...(nextBinding || {}),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  getRuntimeForWorkspace(bindingKey, workspaceRoot, fallbackRuntime = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedFallbackRuntime = normalizeRuntimeId(fallbackRuntime);
    if (!normalizedWorkspaceRoot) {
      return normalizedFallbackRuntime;
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeByWorkspaceRoot = getRuntimeMap(current);
    return normalizeRuntimeId(runtimeByWorkspaceRoot[normalizedWorkspaceRoot]) || normalizedFallbackRuntime;
  }

  setRuntimeForWorkspace(bindingKey, workspaceRoot, runtimeId) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedWorkspaceRoot || !normalizedRuntimeId) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      activeRuntimeByWorkspaceRoot: {
        ...getRuntimeMap(current),
        [normalizedWorkspaceRoot]: normalizedRuntimeId,
      },
    });
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    const current = this.getBinding(bindingKey) || {};
    if (normalizedRuntimeId) {
      const runtimeThreadMap = getThreadMapByRuntime(current)[normalizedWorkspaceRoot];
      if (runtimeThreadMap && typeof runtimeThreadMap === "object") {
        return normalizeValue(runtimeThreadMap[normalizedRuntimeId]);
      }
    }
    return normalizeValue(getLegacyThreadMap(current)[normalizedWorkspaceRoot]);
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}, runtimeId = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedThreadId = normalizeValue(threadId);
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByRuntimeByWorkspaceRoot = {
      ...getThreadMapByRuntime(current),
      [normalizedWorkspaceRoot]: {
        ...(getThreadMapByRuntime(current)[normalizedWorkspaceRoot] || {}),
        ...(normalizedRuntimeId ? { [normalizedRuntimeId]: normalizedThreadId } : {}),
      },
    };
    const nextBinding = {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByRuntimeByWorkspaceRoot,
    };
    if (normalizedRuntimeId) {
      nextBinding.activeRuntimeByWorkspaceRoot = {
        ...getRuntimeMap(current),
        [normalizedWorkspaceRoot]: normalizedRuntimeId,
      };
    } else {
      nextBinding.threadIdByWorkspaceRoot = {
        ...getLegacyThreadMap(current),
        [normalizedWorkspaceRoot]: normalizedThreadId,
      };
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  getRuntimeParamsForWorkspace(bindingKey, workspaceRoot, runtimeId = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedWorkspaceRoot) {
      return { model: "" };
    }
    const current = this.getBinding(bindingKey) || {};
    if (normalizedRuntimeId) {
      const runtimeParams = getRuntimeParamsMap(current)[normalizedWorkspaceRoot];
      if (runtimeParams && typeof runtimeParams === "object") {
        return {
          model: normalizeValue(runtimeParams[normalizedRuntimeId]?.model),
        };
      }
    }
    const legacyParams = getLegacyRuntimeParamsMap(current)[normalizedWorkspaceRoot];
    return {
      model: normalizeValue(legacyParams?.model),
    };
  }

  setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, runtimeId, { model = "" }) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedWorkspaceRoot || !normalizedRuntimeId) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeParamsByRuntimeByWorkspaceRoot = {
      ...getRuntimeParamsMap(current),
      [normalizedWorkspaceRoot]: {
        ...(getRuntimeParamsMap(current)[normalizedWorkspaceRoot] || {}),
        [normalizedRuntimeId]: {
          model: normalizeValue(model),
        },
      },
    };
    return this.updateBinding(bindingKey, {
      ...current,
      runtimeParamsByRuntimeByWorkspaceRoot,
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot, runtimeId = "") {
    return this.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot, runtimeId);
  }

  setCodexParamsForWorkspace(bindingKey, workspaceRoot, { model = "" }, runtimeId = "") {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId) || "codex";
    return this.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, normalizedRuntimeId, { model });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    if (!normalizedRuntimeId) {
      return this.updateBinding(bindingKey, {
        ...current,
        threadIdByWorkspaceRoot: {
          ...getLegacyThreadMap(current),
          [normalizedWorkspaceRoot]: "",
        },
      });
    }
    return this.updateBinding(bindingKey, {
      ...current,
      threadIdByRuntimeByWorkspaceRoot: {
        ...getThreadMapByRuntime(current),
        [normalizedWorkspaceRoot]: {
          ...(getThreadMapByRuntime(current)[normalizedWorkspaceRoot] || {}),
          [normalizedRuntimeId]: "",
        },
      },
    });
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    return this.updateBinding(bindingKey, {
      activeWorkspaceRoot: normalizedWorkspaceRoot,
    });
  }

  listWorkspaceRoots(bindingKey) {
    const current = this.getBinding(bindingKey) || {};
    return Array.from(new Set([
      ...Object.keys(getLegacyThreadMap(current)),
      ...Object.keys(getThreadMapByRuntime(current)),
      ...Object.keys(getLegacyRuntimeParamsMap(current)),
      ...Object.keys(getRuntimeParamsMap(current)),
      ...Object.keys(getRuntimeMap(current)),
    ].map((value) => normalizeValue(value)).filter(Boolean)));
  }

  findBindingForThreadId(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      for (const [workspaceRoot, candidateThreadId] of Object.entries(getLegacyThreadMap(binding))) {
        if (normalizeValue(candidateThreadId) === normalizedThreadId) {
          return {
            bindingKey,
            workspaceRoot: normalizeValue(workspaceRoot),
            runtimeId: "",
          };
        }
      }
      for (const [workspaceRoot, runtimeMap] of Object.entries(getThreadMapByRuntime(binding))) {
        if (!runtimeMap || typeof runtimeMap !== "object") {
          continue;
        }
        for (const [runtimeId, candidateThreadId] of Object.entries(runtimeMap)) {
          if (normalizeValue(candidateThreadId) === normalizedThreadId) {
            return {
              bindingKey,
              workspaceRoot: normalizeValue(workspaceRoot),
              runtimeId: normalizeRuntimeId(runtimeId),
            };
          }
        }
      }
    }
    return null;
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const raw = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((entry) => Array.isArray(entry))
      .map((entry) => entry.map((part) => normalizeValue(part)).filter(Boolean))
      .filter((entry) => entry.length);
  }

  rememberApprovalPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return this.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
    }
    const current = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    if (!current.some((entry) => isSameTokenList(entry, normalizedTokens))) {
      current.push(normalizedTokens);
      this.state.approvalCommandAllowlistByWorkspaceRoot = {
        ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
        [normalizedWorkspaceRoot]: current,
      };
      this.save();
    }
    return current;
  }

  getApprovalPromptState(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const raw = this.state.approvalPromptStateByThreadId?.[normalizedThreadId];
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return {
      requestId: normalizeValue(raw.requestId),
      signature: normalizeValue(raw.signature),
      promptedAt: normalizeValue(raw.promptedAt),
    };
  }

  rememberApprovalPrompt(threadId, requestId, signature = "") {
    const normalizedThreadId = normalizeValue(threadId);
    const normalizedRequestId = normalizeValue(requestId);
    const normalizedSignature = normalizeValue(signature);
    if (!normalizedThreadId || !normalizedRequestId) {
      return null;
    }
    this.state.approvalPromptStateByThreadId = {
      ...(this.state.approvalPromptStateByThreadId || {}),
      [normalizedThreadId]: {
        requestId: normalizedRequestId,
        signature: normalizedSignature,
        promptedAt: new Date().toISOString(),
      },
    };
    this.save();
    return this.getApprovalPromptState(normalizedThreadId);
  }

  clearApprovalPrompt(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId || !this.state.approvalPromptStateByThreadId?.[normalizedThreadId]) {
      return;
    }
    const next = {
      ...(this.state.approvalPromptStateByThreadId || {}),
    };
    delete next[normalizedThreadId];
    this.state.approvalPromptStateByThreadId = next;
    this.save();
  }

  getAvailableModelCatalog(runtimeId = "") {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (normalizedRuntimeId) {
      const raw = this.state.availableModelCatalogByRuntime?.[normalizedRuntimeId];
      if (!raw || typeof raw !== "object") {
        return null;
      }
      const models = normalizeModelCatalog(raw.models);
      if (!models.length) {
        return null;
      }
      return {
        models,
        updatedAt: normalizeValue(raw.updatedAt),
      };
    }
    const runtimes = Object.keys(this.state.availableModelCatalogByRuntime || {});
    for (const candidateRuntimeId of runtimes) {
      const catalog = this.getAvailableModelCatalog(candidateRuntimeId);
      if (catalog) {
        return catalog;
      }
    }
    return null;
  }

  setAvailableModelCatalog(runtimeId, models) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedRuntimeId || !normalizedModels.length) {
      return null;
    }
    this.state.availableModelCatalogByRuntime = {
      ...(this.state.availableModelCatalogByRuntime || {}),
      [normalizedRuntimeId]: {
        models: normalizedModels,
        updatedAt: new Date().toISOString(),
      },
    };
    this.save();
    return this.state.availableModelCatalogByRuntime[normalizedRuntimeId];
  }

  buildBindingKey({ workspaceId, accountId, senderId }) {
    return `${normalizeValue(workspaceId)}:${normalizeValue(accountId)}:${normalizeValue(senderId)}`;
  }
}

function createEmptyState() {
  return {
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalPromptStateByThreadId: {},
    availableModelCatalogByRuntime: {},
  };
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRuntimeId(value) {
  const normalized = normalizeValue(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "openai" || normalized === "codex") {
    return "codex";
  }
  if (normalized === "claude" || normalized === "claude-code" || normalized === "claudecode") {
    return "claude-code";
  }
  if (normalized === "aliyun" || normalized === "dashscope") {
    return "aliyun";
  }
  if (normalized === "qwen") {
    return "qwen";
  }
  return normalized;
}

function getLegacyThreadMap(binding) {
  return binding?.threadIdByWorkspaceRoot && typeof binding.threadIdByWorkspaceRoot === "object"
    ? binding.threadIdByWorkspaceRoot
    : {};
}

function getThreadMapByRuntime(binding) {
  return binding?.threadIdByRuntimeByWorkspaceRoot && typeof binding.threadIdByRuntimeByWorkspaceRoot === "object"
    ? binding.threadIdByRuntimeByWorkspaceRoot
    : {};
}

function getLegacyRuntimeParamsMap(binding) {
  return binding?.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
    ? binding.codexParamsByWorkspaceRoot
    : {};
}

function getRuntimeParamsMap(binding) {
  return binding?.runtimeParamsByRuntimeByWorkspaceRoot && typeof binding.runtimeParamsByRuntimeByWorkspaceRoot === "object"
    ? binding.runtimeParamsByRuntimeByWorkspaceRoot
    : {};
}

function getRuntimeMap(binding) {
  return binding?.activeRuntimeByWorkspaceRoot && typeof binding.activeRuntimeByWorkspaceRoot === "object"
    ? binding.activeRuntimeByWorkspaceRoot
    : {};
}

function normalizeCommandTokens(tokens) {
  return Array.isArray(tokens)
    ? tokens.map((part) => normalizeValue(part)).filter(Boolean)
    : [];
}

function isSameTokenList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

module.exports = { SessionStore, normalizeRuntimeId };
