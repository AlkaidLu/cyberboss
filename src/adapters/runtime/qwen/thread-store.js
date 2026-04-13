const fs = require("fs");
const path = require("path");

class QwenThreadStore {
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
      if (parsed && typeof parsed === "object" && parsed.threads && typeof parsed.threads === "object") {
        this.state = {
          threads: parsed.threads,
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  getThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const thread = this.state.threads[normalizedThreadId];
    if (!thread || typeof thread !== "object") {
      return null;
    }
    return {
      threadId: normalizedThreadId,
      messages: Array.isArray(thread.messages) ? thread.messages : [],
      updatedAt: normalizeText(thread.updatedAt),
    };
  }

  appendTurn(threadId, userText, assistantText) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const current = this.getThread(normalizedThreadId) || {
      threadId: normalizedThreadId,
      messages: [],
      updatedAt: "",
    };
    const messages = [
      ...current.messages,
      createMessage("user", userText),
      createMessage("assistant", assistantText),
    ].filter(Boolean);
    this.state.threads[normalizedThreadId] = {
      messages,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.getThread(normalizedThreadId);
  }

  getMessages(threadId) {
    return this.getThread(threadId)?.messages || [];
  }
}

function createMessage(role, content) {
  const normalizedRole = normalizeText(role);
  const normalizedContent = normalizeText(content);
  if (!normalizedRole || !normalizedContent) {
    return null;
  }
  return {
    role: normalizedRole,
    content: normalizedContent,
  };
}

function createEmptyState() {
  return {
    threads: {},
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { QwenThreadStore };
