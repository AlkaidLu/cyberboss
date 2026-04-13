const crypto = require("crypto");
const https = require("https");

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BODY_BYTES = 64 << 20;
const CHANNEL_VERSION = "cyberboss-weixin/2.0";

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildHeaders(token, body) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (typeof token === "string" && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiPost({ baseUrl, endpoint, token, body, timeoutMs = 0, label }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
  const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_API_TIMEOUT_MS;
  try {
    const { statusCode, bodyText } = await requestOverHttps(url, {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
      timeoutMs: timeout + 5_000,
    });
    if (Buffer.byteLength(bodyText, "utf8") > MAX_RESPONSE_BODY_BYTES) {
      throw new Error(`${label} response body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`);
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`${label} http ${statusCode}: ${truncateForLog(bodyText, 512)}`);
    }
    return bodyText;
  } catch (error) {
    throw new Error(`${label} fetch failed (${url}): ${formatFetchError(error)}`);
  }
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
        if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BODY_BYTES) {
          request.destroy(new Error(`response body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`));
        }
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

async function getUpdatesV2({ baseUrl, token, getUpdatesBuf = "", timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS }) {
  const payload = JSON.stringify({
    get_updates_buf: getUpdatesBuf,
    base_info: buildBaseInfo(),
  });
  try {
    const raw = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      token,
      body: payload,
      timeoutMs,
      label: "getUpdates",
    });
    return parseJson(raw, "getUpdates");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    if (String(error?.message || "").includes("aborted")) {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  }
}

async function sendTextV2({ baseUrl, token, toUserId, text, contextToken, clientId }) {
  if (!String(contextToken || "").trim()) {
    throw new Error("weixin-v2 sendText requires contextToken");
  }
  const itemList = [];
  if (String(text || "").trim()) {
    itemList.push({
      type: 1,
      text_item: { text: String(text) },
    });
  }
  if (!itemList.length) {
    throw new Error("weixin-v2 sendText requires non-empty text");
  }
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId || `cb-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: itemList,
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    label: "sendMessage",
  });
  const parsed = parseJson(raw, "sendMessage");
  if ((parsed?.ret ?? 0) !== 0) {
    throw new Error(`sendMessage ret=${parsed?.ret ?? ""} errcode=${parsed?.errcode ?? ""} errmsg=${parsed?.errmsg ?? ""}`);
  }
  return parsed;
}

module.exports = {
  getUpdatesV2,
  sendTextV2,
};
