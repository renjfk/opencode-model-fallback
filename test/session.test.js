import { expect, test } from "vitest";

import { getSessionReplay } from "../lib/session.js";

const DIRECTORY = "/tmp/project";

test("fresh failure replays the latest user message parts", async () => {
  const messages = [
    userMessage([{ type: "text", text: "first" }]),
    assistantMessage([{ type: "text", text: "done" }]),
    userMessage([{ type: "text", text: "hello" }]),
  ];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay).toEqual({ parts: [{ type: "text", text: "hello" }], inFlight: false });
});

test("assistant text after the latest user message marks the run in flight", async () => {
  const messages = [
    userMessage([{ type: "text", text: "hello" }]),
    assistantMessage([{ type: "step-start" }, { type: "text", text: "partial work" }]),
  ];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay.inFlight).toBe(true);
  expect(replay.parts).toEqual([{ type: "text", text: "hello" }]);
});

test("tool parts on assistant messages mark the run in flight", async () => {
  const messages = [
    userMessage([{ type: "text", text: "hello" }]),
    assistantMessage([
      { type: "step-start" },
      { type: "tool", tool: "read", state: { status: "pending" } },
    ]),
  ];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay.inFlight).toBe(true);
});

test("step-start only assistant parts keep the run fresh", async () => {
  const messages = [
    userMessage([{ type: "text", text: "hello" }]),
    assistantMessage([{ type: "step-start" }]),
  ];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay.inFlight).toBe(false);
});

test("empty assistant text does not mark the run in flight", async () => {
  const messages = [
    userMessage([{ type: "text", text: "hello" }]),
    assistantMessage([{ type: "step-start" }, { type: "text", text: "  " }]),
  ];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay.inFlight).toBe(false);
});

test("compaction parts are filtered from replay parts", async () => {
  const messages = [
    userMessage([
      { type: "compaction", auto: true },
      { type: "text", text: "hello" },
    ]),
  ];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay.parts).toEqual([{ type: "text", text: "hello" }]);
});

test("sessions without user messages return no replay parts", async () => {
  const messages = [assistantMessage([{ type: "text", text: "orphan" }])];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay).toEqual({ parts: [], inFlight: false });
});

test("empty message list returns no replay parts", async () => {
  const replay = await getSessionReplay(clientWith([]), DIRECTORY, "session-1");

  expect(replay).toEqual({ parts: [], inFlight: false });
});

test("user messages without parts are skipped", async () => {
  const messages = [
    userMessage([{ type: "text", text: "first" }]),
    assistantMessage([{ type: "text", text: "done" }]),
    userMessage([]),
  ];

  const replay = await getSessionReplay(clientWith(messages), DIRECTORY, "session-1");

  expect(replay.parts).toEqual([{ type: "text", text: "first" }]);
  expect(replay.inFlight).toBe(true);
});

function clientWith(messages) {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  };
}

function userMessage(parts) {
  return { info: { role: "user" }, parts };
}

function assistantMessage(parts) {
  return { info: { role: "assistant" }, parts };
}
