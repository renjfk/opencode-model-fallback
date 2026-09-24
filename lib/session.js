export async function abortSession(client, sessionID) {
  try {
    await client.session.abort({ path: { id: sessionID } });
    return true;
  } catch {
    // Best effort. The session may already be idle after an error.
    return false;
  }
}

export async function getSessionReplay(client, directory, sessionID) {
  const response = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  });
  const messages = response.data ?? [];
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex === -1) return { parts: [], inFlight: false };
  const parts = messageParts(messages[lastUserIndex]).filter(isReplayablePart);
  const inFlight = messages
    .slice(lastUserIndex + 1)
    .some((message) => isAssistant(message) && madeProgress(messageParts(message)));
  return { parts, inFlight };
}

function findLastUserMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const role = String(message.info?.role ?? "").toLowerCase();
    if (role === "user" && messageParts(message).length > 0) return index;
  }
  return -1;
}

function messageParts(message) {
  return message.parts ?? message.info?.parts ?? [];
}

function isAssistant(message) {
  return String(message.info?.role ?? "").toLowerCase() === "assistant";
}

function isReplayablePart(part) {
  return typeof part.type === "string" && part.type !== "compaction";
}

function madeProgress(parts) {
  return parts.some((part) => {
    if (part.type === "tool") return true;
    if (part.type === "text" || part.type === "reasoning") {
      return typeof part.text === "string" && part.text.trim() !== "";
    }
    return false;
  });
}
