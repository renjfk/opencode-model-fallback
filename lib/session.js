export async function abortSession(client, sessionID) {
  try {
    await client.session.abort({ path: { id: sessionID } });
    return true;
  } catch {
    // Best effort. The session may already be idle after an error.
    return false;
  }
}

export async function getReplayParts(client, directory, sessionID) {
  const response = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  });
  const messages = response.data ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const role = String(message.info?.role ?? "").toLowerCase();
    const parts = message.parts ?? message.info?.parts ?? [];
    if (role !== "user" || parts.length === 0) continue;
    return parts.filter((part) => typeof part.type === "string" && part.type !== "compaction");
  }
  return [];
}
