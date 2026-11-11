import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { OpenCode } from "@opencode/client";

// End-to-end: a real `opencode serve` process with this plugin loaded, a mock
// OpenAI-compatible provider that rejects the original model with 429 and
// streams a reply for the fallback model. Proves the whole chain the unit
// tests mock out: the retry hook fires on the 429, the session is switched,
// the forced retry runs on the fallback, the cooldown routes later prompts
// away from the original, and the assistant reply survives.
//
// Opt-in because it spawns the opencode binary: run with
//   npm run test:e2e
// (plain `npm test` skips it).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2eRequested = process.env.OPENCODE_E2E === "1";
// Probe the binary lazily: plain `npm test` / `check` / `prepack` must not
// spawn opencode at all.
const hasOpencode = e2eRequested
  ? (() => {
      try {
        return spawnSync("opencode", ["--version"], { timeout: 10_000 }).status === 0;
      } catch {
        return false;
      }
    })()
  : false;
const run = e2eRequested && hasOpencode;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The mock provider: 429 (rate limit) for the original model, a streamed
// chat completion for everything else. Every request is recorded in order.
function startMock() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      const model = parsed.model ?? "";
      if (req.url.includes("/chat/completions") && model.includes("original")) {
        requests.push({ model, status: 429, stream: Boolean(parsed.stream) });
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "rate limit exceeded", type: "rate_limit_error", code: 429 },
          }),
        );
        return;
      }
      if (req.url.includes("/chat/completions")) {
        requests.push({ model, status: 200, stream: Boolean(parsed.stream) });
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          chunk({ role: "assistant" }, null) +
            chunk({ content: "fallback reply" }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
        return;
      }
      requests.push({ model: model || null, status: 200, stream: false });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

// A foreground `opencode serve` with its config, data, and state rooted in a
// temp directory. The generated server password is parsed from stdout.
function startOpencode(envRoot, mockPort, apiPort) {
  mkdirSync(path.join(envRoot, "config", "opencode"), { recursive: true });
  writeFileSync(
    path.join(envRoot, "config", "opencode", "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        providers: {
          mock: {
            name: "Mock",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "dummy" },
            models: {
              original: { name: "Original", variants: [{ id: "high" }] },
              fallback: { name: "Fallback", variants: [{ id: "high" }] },
            },
          },
        },
        plugins: [
          {
            package: repoRoot,
            options: {
              mappings: { "mock/original": "mock/fallback", "mock/missing": "mock/fallback" },
              notify_on_fallback: true,
              cooldown_seconds: 3600,
            },
          },
        ],
      },
      null,
      2,
    ),
  );

  const child = spawn("opencode", ["serve", "--port", String(apiPort), "--hostname", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      // Scrub the developer's OpenCode variables: OPENCODE_CONFIG would pull
      // the real permissions file into the "isolated" server, and
      // OPENCODE_PASSWORD / OPENCODE_SERVER_PASSWORD would suppress the
      // stdout password this harness parses.
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_")),
      ),
      XDG_CONFIG_HOME: path.join(envRoot, "config"),
      XDG_DATA_HOME: path.join(envRoot, "data"),
      XDG_CACHE_HOME: path.join(envRoot, "cache"),
      XDG_STATE_HOME: path.join(envRoot, "state"),
    },
  });
  let output = "";
  const record = (chunk) => (output += chunk.toString());
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  // A detached child that never becomes ready must not outlive the failure.
  const kill = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    } catch {}
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`opencode serve did not start in 30s\n${output}`));
    }, 30_000);
    const poll = setInterval(() => {
      if (/server listening on/.test(output)) {
        const password = /server password (\S+)/.exec(output)?.[1];
        if (!password) return; // still printing
        clearTimeout(timer);
        clearInterval(poll);
        resolve({ child, password, output: () => output });
      }
      if (child.exitCode !== null) {
        clearTimeout(timer);
        clearInterval(poll);
        kill();
        reject(new Error(`opencode serve exited with ${child.exitCode}\n${output}`));
      }
    }, 100);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(poll);
      kill();
      reject(error);
    });
  });
}

const state = {};

async function turnDone(client, sessionID) {
  await Promise.race([
    client.experimental.session.wait({ sessionID }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("turn did not finish in 60s")), 60_000),
    ),
  ]);
}

async function assistantText(client, sessionID) {
  const messages = await client.session.context({ sessionID });
  return messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
}

describe.skipIf(!run)("e2e: fallback against a real opencode server", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    state.envRoot = mkdtempSync(path.join(os.tmpdir(), "model-fallback-e2e-"));
    state.mock = await startMock();
    const apiPort = await freePort();
    state.server = await startOpencode(state.envRoot, state.mock.port, apiPort);
    state.client = OpenCode.make({
      baseUrl: `http://127.0.0.1:${apiPort}`,
      headers: {
        authorization:
          "Basic " + Buffer.from(`opencode:${state.server.password}`).toString("base64"),
      },
    });
  }, 120_000);

  afterAll(() => {
    if (state.server?.child?.pid) {
      try {
        process.kill(-state.server.child.pid, "SIGTERM");
      } catch {}
    }
    state.mock?.server?.close();
    if (state.envRoot) rmSync(state.envRoot, { recursive: true, force: true });
  });

  test("a retryable 429 on the original switches the session and finishes the turn on the fallback", async () => {
    const session = await state.client.session.create({
      title: "e2e fallback",
      model: { providerID: "mock", id: "original" },
    });
    expect(session.model).toMatchObject({ providerID: "mock", id: "original" });

    await state.client.session.prompt({ sessionID: session.id, text: "hello" });
    await turnDone(state.client, session.id);

    // The session is persisted on the fallback model.
    const after = await state.client.session.get({ sessionID: session.id });
    expect(after.model).toMatchObject({ providerID: "mock", id: "fallback" });

    // The turn produced a real assistant reply from the fallback model.
    expect(await assistantText(state.client, session.id)).toContain("fallback reply");

    // The provider saw the original fail retryably, and everything after that
    // first 429 ran on the fallback.
    const first429 = state.mock.requests.findIndex(
      (request) => request.model?.includes("original") && request.status === 429,
    );
    expect(first429).toBeGreaterThanOrEqual(0);
    for (const [index, request] of state.mock.requests.entries()) {
      if (index > first429 && request.model?.includes("original")) {
        throw new Error(
          `original model was used again after the 429: request ${index} ${JSON.stringify(request)}`,
        );
      }
    }
    expect(
      state.mock.requests.some(
        (request) => request.model?.includes("fallback") && request.status === 200,
      ),
    ).toBe(true);

    // The route change was logged (the V2 replacement for V1 toasts).
    expect(state.server.output()).toMatch(/\[model-fallback\]/);
  });

  test("the cooldown routes later sessions to the fallback without touching the original", async () => {
    const originalCallsBefore = state.mock.requests.filter((request) =>
      request.model?.includes("original"),
    ).length;

    const session = await state.client.session.create({
      title: "e2e cooldown",
      model: { providerID: "mock", id: "original" },
    });
    await state.client.session.prompt({ sessionID: session.id, text: "hello again" });
    await turnDone(state.client, session.id);

    expect(await assistantText(state.client, session.id)).toContain("fallback reply");
    const after = await state.client.session.get({ sessionID: session.id });
    expect(after.model).toMatchObject({ providerID: "mock", id: "fallback" });

    // No request reached the original model: the prompt hook routed the
    // session to the fallback before any request was built.
    const originalCallsAfter = state.mock.requests.filter((request) =>
      request.model?.includes("original"),
    ).length;
    expect(originalCallsAfter).toBe(originalCallsBefore);
  });

  test("an unavailable model routes to the fallback before the request is built", async () => {
    // mock/missing is mapped but not declared in the mock provider's model
    // list, so it never enters OpenCode's enabled inventory. Without routing,
    // the turn dies with a hard "Model unavailable" resolution error.
    const session = await state.client.session.create({
      title: "e2e unavailable",
      model: { providerID: "mock", id: "missing" },
    });
    await state.client.session.prompt({ sessionID: session.id, text: "hello missing" });
    await turnDone(state.client, session.id);

    expect(await assistantText(state.client, session.id)).toContain("fallback reply");
    const after = await state.client.session.get({ sessionID: session.id });
    expect(after.model).toMatchObject({ providerID: "mock", id: "fallback" });

    // The unavailable model never reached the provider.
    expect(state.mock.requests.some((request) => request.model?.includes("missing"))).toBe(false);
    expect(
      state.mock.requests.some(
        (request) => request.model?.includes("fallback") && request.status === 200,
      ),
    ).toBe(true);
  });

  test("a routed fallback keeps the session's reasoning effort when the target supports it", async () => {
    const session = await state.client.session.create({
      title: "e2e effort",
      model: { providerID: "mock", id: "original", variant: "high" },
    });
    await state.client.session.prompt({ sessionID: session.id, text: "hello effort" });
    await turnDone(state.client, session.id);

    expect(await assistantText(state.client, session.id)).toContain("fallback reply");
    const after = await state.client.session.get({ sessionID: session.id });
    expect(after.model).toMatchObject({ providerID: "mock", id: "fallback", variant: "high" });
  });
});

if (!run) {
  test(
    run === false && process.env.OPENCODE_E2E === "1"
      ? "e2e skipped: opencode binary not found"
      : "e2e skipped: set OPENCODE_E2E=1 to run",
    () => {},
  );
}
