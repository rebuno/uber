import type { AssistantMessage } from "@earendil-works/pi-ai";

// Live deltas as the message Pi renders. Deltas can split a line anywhere, so
// only complete lines are parsed.
export function streamedMessage(raw: string): AssistantMessage {
  let text = "";
  let thinking = "";
  const lines = raw.split("\n");
  lines.pop();
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6)) as { type: string; delta: string };
    if (event.type === "text") text += event.delta;
    else if (event.type === "thinking") thinking += event.delta;
  }
  return {
    role: "assistant",
    content: [
      ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
      ...(text ? [{ type: "text" as const, text }] : []),
    ],
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

export function messageText(message: AssistantMessage) {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

// pi's compaction summarizes with its own system prompt.
export function isSummarization(requestArgs: unknown) {
  return String(
    (requestArgs as { systemPrompt?: unknown } | undefined)?.systemPrompt,
  ).includes("You are a context summarization assistant");
}
