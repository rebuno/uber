import type { AssistantMessage } from "@earendil-works/pi-ai";

type Part = { type?: string; text?: string; thinking?: string };
type Event = {
  type?: string;
  delta?: string | { type?: string; text?: string; thinking?: string };
  choices?: {
    delta?: Delta;
    message?: Delta;
  }[];
  content?: Part[];
  output?: { type?: string; content?: Part[]; summary?: Part[] }[];
};
type Delta = {
  content?: string | Part[] | null;
  reasoning_content?: string | null;
};

// A recorded model response, whole or as an event stream, in the Chat
// Completions, Anthropic Messages, or OpenAI Responses format, as the message
// Pi renders.
export function assistantMessage(body: string): AssistantMessage {
  let text = "";
  let thinking = "";
  const take = (event: Event) => {
    const choice = event.choices?.[0]?.delta ?? event.choices?.[0]?.message;
    if (choice) {
      const { content } = choice;
      if (typeof content === "string") text += content;
      else
        for (const part of content ?? [])
          if (part.type === "text") text += part.text ?? "";
      thinking += choice.reasoning_content ?? "";
    }
    const { delta } = event;
    if (event.type === "content_block_delta" && typeof delta === "object") {
      text += delta.text ?? "";
      thinking += delta.thinking ?? "";
    }
    if (typeof delta === "string") {
      if (event.type === "response.output_text.delta") text += delta;
      if (event.type?.startsWith("response.reasoning_")) thinking += delta;
    }
    for (const part of event.content ?? []) {
      if (part.type === "text") text += part.text ?? "";
      if (part.type === "thinking") thinking += part.thinking ?? "";
    }
    for (const item of event.output ?? []) {
      for (const part of item.content ?? [])
        if (part.type === "output_text") text += part.text ?? "";
      for (const part of item.summary ?? []) thinking += part.text ?? "";
    }
  };
  if (body.trimStart().startsWith("{")) {
    take(JSON.parse(body));
  } else {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        take(JSON.parse(line.slice(6)));
      } catch {
        // A partial line at the end of a live stream.
      }
    }
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
  const args = (requestArgs ?? {}) as {
    system?: unknown;
    instructions?: unknown;
    messages?: unknown[];
    input?: unknown[];
  };
  return JSON.stringify([
    args.system,
    args.instructions,
    args.messages?.[0],
    args.input?.[0],
  ]).includes("You are a context summarization assistant");
}
