const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClaudeCommandArgs,
  parseClaudeJsonOutput,
  resolveClaudeModelCatalog,
  buildRuntimeEnv,
} = require("../src/adapters/runtime/claude-code");
const { resolveQwenApiKey, buildQwenTools, normalizeToolArguments } = require("../src/adapters/runtime/qwen");
const { resolveRequestedDate } = require("../src/adapters/runtime/qwen/timeline-tool");
const { createRuntimeAdapter } = require("../src/adapters/runtime");

test("runtime factory selects claude-code runtime aliases", () => {
  const config = {
    runtime: "claudecode",
    sessionsFile: "x",
  };
  const adapter = createRuntimeAdapter(config);
  assert.equal(adapter.describe().id, "claude-code");
});

test("claude command args use session creation for new threads", () => {
  const args = buildClaudeCommandArgs({
    prompt: "hello",
    threadId: "thread-1",
    model: "claude-sonnet-4",
    permissionMode: "acceptEdits",
    additionalArgs: ["--verbose"],
    resume: false,
  });

  assert.deepEqual(args, [
    "--session-id", "thread-1",
    "--model", "claude-sonnet-4",
    "--permission-mode", "acceptEdits",
    "--verbose",
    "-p", "hello",
    "--output-format", "json",
  ]);
});

test("claude command args resume existing threads", () => {
  const args = buildClaudeCommandArgs({
    prompt: "continue",
    threadId: "thread-2",
    resume: true,
  });

  assert.deepEqual(args, [
    "--resume", "thread-2",
    "-p", "continue",
    "--output-format", "json",
  ]);
});

test("claude command args preserve unicode prompts", () => {
  const prompt = "\u4f60\u597d\uff0c\u5e2e\u6211\u770b\u4e0b\u8fd9\u4e2a\u62a5\u9519";
  const args = buildClaudeCommandArgs({
    prompt,
    threadId: "thread-3",
    resume: true,
  });

  assert.deepEqual(args, [
    "--resume", "thread-3",
    "-p", prompt,
    "--output-format", "json",
  ]);
});

test("claude json output parses result text and session id", () => {
  assert.deepEqual(
    parseClaudeJsonOutput("{\"result\":\"hello\\nworld\",\"session_id\":\"sess-1\"}"),
    { text: "hello\nworld", sessionId: "sess-1" }
  );
});

test("claude json output falls back to raw text", () => {
  assert.deepEqual(
    parseClaudeJsonOutput("\n\nhello\nworld\n"),
    { text: "hello\nworld", sessionId: "" }
  );
});

test("claude model catalog uses configured override when provided", () => {
  assert.deepEqual(
    resolveClaudeModelCatalog({
      claudeModelCatalog: ["qwen-turbo", "qwen3-coder-next"],
    }).map((item) => item.model),
    ["qwen-turbo", "qwen3-coder-next"]
  );
});

test("claude runtime env overlays provider-specific credentials", () => {
  const env = buildRuntimeEnv({
    runtimeEnv: {
      ANTHROPIC_API_KEY: "aliyun-key",
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
    },
  });

  assert.equal(env.ANTHROPIC_API_KEY, "aliyun-key");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://dashscope.aliyuncs.com/apps/anthropic");
});

test("qwen api key resolves from explicit config", () => {
  assert.equal(resolveQwenApiKey({ qwenApiKey: "dashscope-key" }), "dashscope-key");
});

test("qwen exposes timeline tool", () => {
  assert.deepEqual(
    buildQwenTools().map((tool) => tool.function.name),
    [
      "get_timeline_snapshot",
      "write_timeline_events",
      "build_timeline_site",
      "queue_timeline_screenshot",
    ]
  );
});

test("timeline tool resolves relative today requests", () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assert.equal(
    resolveRequestedDate("今天", {
      availableDates: ["2026-04-10", today],
      timezone: "Asia/Shanghai",
    }),
    today
  );
});

test("qwen tool arguments are normalized to valid json strings", () => {
  assert.equal(normalizeToolArguments({ date: "2026-04-13" }), "{\"date\":\"2026-04-13\"}");
  assert.equal(normalizeToolArguments("{\"date\":\"2026-04-13\"}"), "{\"date\":\"2026-04-13\"}");
});
