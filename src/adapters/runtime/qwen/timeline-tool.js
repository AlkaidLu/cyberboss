const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { createTimelineIntegration } = require("../../../integrations/timeline");
const { TimelineScreenshotQueueStore } = require("../../../core/timeline-screenshot-queue-store");
const { resolveSelectedAccount } = require("../../../adapters/channel/weixin/account-store");

function readTimelineSnapshot(config = {}, options = {}) {
  const state = loadTimelineState(config);
  const facts = state?.facts && typeof state.facts === "object" ? state.facts : {};
  const availableDates = Object.keys(facts).sort();
  if (!availableDates.length) {
    return {
      ok: false,
      error: "timeline is empty",
      availableDates: [],
    };
  }

  const selectedDate = resolveRequestedDate(options.date, {
    availableDates,
    timezone: normalizeText(state?.timezone) || "Asia/Shanghai",
  });
  if (!selectedDate) {
    return {
      ok: false,
      error: "requested date is unavailable",
      requestedDate: normalizeText(options.date),
      availableDates: availableDates.slice(-14),
    };
  }

  const day = facts[selectedDate];
  const rawEvents = Array.isArray(day?.events) ? day.events : [];
  const limit = normalizePositiveInteger(options.limit) || 24;
  const includeNotes = options.include_notes !== false;
  const events = rawEvents
    .slice()
    .sort((left, right) => String(left?.startAt || "").localeCompare(String(right?.startAt || "")))
    .slice(0, limit)
    .map((event) => ({
      id: normalizeText(event?.id),
      startAt: normalizeText(event?.startAt),
      endAt: normalizeText(event?.endAt),
      title: normalizeText(event?.title),
      note: includeNotes ? truncateText(normalizeText(event?.note), 300) : "",
      categoryId: normalizeText(event?.categoryId),
      subcategoryId: normalizeText(event?.subcategoryId),
      tags: normalizeTags(event?.tags),
      confidence: normalizeFiniteNumber(event?.confidence),
    }));

  return {
    ok: true,
    date: selectedDate,
    timezone: normalizeText(state?.timezone) || "Asia/Shanghai",
    status: normalizeText(day?.status) || "unknown",
    updatedAt: normalizeText(day?.updatedAt),
    eventCount: rawEvents.length,
    availableDates: availableDates.slice(-14),
    events,
  };
}

async function writeTimelineEvents(config = {}, options = {}) {
  const date = normalizeText(options.date);
  if (!date) {
    throw new Error("timeline write requires a date");
  }
  const events = normalizeEvents(options.events);
  const fallbackEvents = events.length ? [] : buildEventsFromRawText(date, options);
  const finalEvents = events.length ? events : fallbackEvents;
  if (!finalEvents.length) {
    throw new Error("timeline write requires at least one event");
  }

  const timeline = createTimelineIntegration(config);
  const tempDir = path.join(normalizeText(config.stateDir) || process.cwd(), "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, `timeline-events-${date}-${Date.now()}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify({ events: finalEvents }, null, 2), "utf8");
  try {
    await timeline.runSubcommand("write", [
      "--date",
      date,
      "--events-file",
      tempFile,
    ]);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // best effort cleanup
    }
  }

  return {
    ok: true,
    date,
    eventCount: finalEvents.length,
    snapshot: readTimelineSnapshot(config, {
      date,
      limit: Math.min(finalEvents.length + 6, 24),
      include_notes: true,
    }),
  };
}

async function buildTimelineSite(config = {}, options = {}) {
  const locale = normalizeText(options.locale);
  const args = locale ? ["--locale", locale] : [];
  const timeline = createTimelineIntegration(config);
  await timeline.runSubcommand("build", args);
  return {
    ok: true,
    locale: locale || "default",
  };
}

function queueTimelineScreenshot(config = {}, options = {}) {
  const senderId = resolveScreenshotSenderId(config, options);
  if (!senderId) {
    throw new Error("timeline screenshot requires a bound WeChat sender");
  }
  const account = resolveSelectedAccount(config);
  const queue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
  const locale = normalizeText(options.locale);
  const selector = normalizeText(options.selector);
  const outputFile = normalizeText(options.output_file);
  const args = [
    ...(selector ? ["--selector", selector] : []),
    ...(locale ? ["--locale", locale] : []),
  ];
  const queued = queue.enqueue({
    id: crypto.randomUUID(),
    accountId: account.accountId,
    senderId,
    outputFile,
    args,
    createdAt: new Date().toISOString(),
  });
  return {
    ok: true,
    queued: true,
    senderId,
    locale: locale || "default",
    selector: selector || "timeline",
    jobId: queued.id,
  };
}

function loadTimelineState(config = {}) {
  const stateDir = normalizeText(config.stateDir);
  if (!stateDir) {
    throw new Error("stateDir is required to read timeline data");
  }
  const filePath = path.join(stateDir, "timeline", "timeline-state.json");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    throw new Error(`failed to read ${filePath}: ${message}`);
  }
}

function resolveScreenshotSenderId(config = {}, options = {}) {
  const explicitSenderId = normalizeText(options.sender_id);
  if (explicitSenderId) {
    return explicitSenderId;
  }
  const bindingKey = normalizeText(options.bindingKey);
  const sessionStore = config.sessionStore;
  if (!bindingKey || !sessionStore || typeof sessionStore.getBinding !== "function") {
    return "";
  }
  const binding = sessionStore.getBinding(bindingKey);
  return normalizeText(binding?.senderId);
}

function resolveRequestedDate(requestedDate, { availableDates, timezone }) {
  if (!Array.isArray(availableDates) || !availableDates.length) {
    return "";
  }
  const token = normalizeText(requestedDate).toLowerCase();
  if (!token || token === "latest" || token === "today" || token === "今天") {
    const today = formatDateInTimeZone(new Date(), timezone);
    return availableDates.includes(today) ? today : availableDates[availableDates.length - 1];
  }
  if (token === "yesterday" || token === "昨天") {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const date = formatDateInTimeZone(yesterday, timezone);
    return availableDates.includes(date) ? date : "";
  }
  return availableDates.includes(token) ? token : "";
}

function formatDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeText(timeZone) || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "00";
  const day = parts.find((part) => part.type === "day")?.value || "00";
  return `${year}-${month}-${day}`;
}

function normalizePositiveInteger(value) {
  const numeric = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item)).filter(Boolean)
    : [];
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }
  return events
    .map((event) => normalizeEvent(event))
    .filter(Boolean);
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const normalized = {
    id: normalizeText(event.id) || `qwen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startAt: normalizeText(event.startAt),
    endAt: normalizeText(event.endAt),
    title: normalizeText(event.title),
    note: normalizeText(event.note),
    categoryId: normalizeText(event.categoryId),
    subcategoryId: normalizeText(event.subcategoryId),
    eventNodeId: normalizeText(event.eventNodeId),
    tags: normalizeTags(event.tags),
  };
  if (!normalized.startAt || !normalized.endAt || !normalized.title) {
    return null;
  }
  if (!normalized.eventNodeId && !normalized.subcategoryId) {
    return null;
  }
  if (!normalized.categoryId && normalized.subcategoryId.includes(".")) {
    normalized.categoryId = normalized.subcategoryId.split(".")[0];
  }
  return normalized;
}

function buildEventsFromRawText(date, options = {}) {
  const rawText = normalizeText(options.raw)
    || normalizeText(options.text)
    || normalizeText(options.note)
    || "";
  if (!rawText) {
    return [];
  }

  const segments = rawText
    .split(/[，。,；;！!？?\n]+/u)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);

  return segments
    .map((segment, index) => buildEventFromSegment(date, segment, index))
    .filter(Boolean);
}

function buildEventFromSegment(date, segment, index) {
  const normalizedDate = normalizeText(date);
  const text = normalizeText(segment);
  if (!normalizedDate || !text) {
    return null;
  }

  const timeRange = resolveSegmentTimeRange(normalizedDate, text, index);
  const classification = classifySegment(text);
  return {
    id: `qwen-fallback-${normalizedDate}-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    startAt: timeRange.startAt,
    endAt: timeRange.endAt,
    title: truncateText(text, 28),
    note: text,
    categoryId: classification.categoryId,
    subcategoryId: classification.subcategoryId,
    eventNodeId: classification.eventNodeId,
    tags: classification.tags,
  };
}

function resolveSegmentTimeRange(date, text, index) {
  const base = normalizeText(date);
  if (/(早餐|早饭|早上|上午)/u.test(text)) {
    return {
      startAt: `${base}T08:00:00+08:00`,
      endAt: `${base}T09:00:00+08:00`,
    };
  }
  if (/(中午|午饭|午餐|米粉|咖啡)/u.test(text)) {
    return {
      startAt: `${base}T12:00:00+08:00`,
      endAt: `${base}T13:30:00+08:00`,
    };
  }
  if (/(下午)/u.test(text)) {
    return {
      startAt: `${base}T14:00:00+08:00`,
      endAt: `${base}T17:30:00+08:00`,
    };
  }
  if (/(晚上|晚饭|晚餐|夜里|熬夜)/u.test(text)) {
    return {
      startAt: `${base}T19:00:00+08:00`,
      endAt: `${base}T21:00:00+08:00`,
    };
  }
  const offsetHours = Math.min(index, 10);
  const hour = String(10 + offsetHours).padStart(2, "0");
  return {
    startAt: `${base}T${hour}:00:00+08:00`,
    endAt: `${base}T${hour}:30:00+08:00`,
  };
}

function classifySegment(text) {
  if (/(代码|编程|debug|调试)/iu.test(text)) {
    return {
      categoryId: "work",
      subcategoryId: "work.coding",
      eventNodeId: "evt.coding",
      tags: ["coding"],
    };
  }
  if (/(咖啡|米粉|午饭|午餐|晚饭|晚餐|早餐|吃)/u.test(text)) {
    return {
      categoryId: "life",
      subcategoryId: "life.meal",
      eventNodeId: "evt.meal",
      tags: ["meal"],
    };
  }
  return {
    categoryId: "life",
    subcategoryId: "life.other",
    eventNodeId: "",
    tags: ["fallback"],
  };
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildTimelineSite,
  queueTimelineScreenshot,
  readTimelineSnapshot,
  resolveRequestedDate,
  writeTimelineEvents,
};
