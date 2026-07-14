export function toGrokResponsesRequest(body = {}) {
  const request = {
    model: body.model,
    input: messagesToInput(body.messages ?? []),
  };
  const instructions = instructionsFrom(body.system);
  if (instructions) {
    request.instructions = instructions;
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
  }
  if (body.tool_choice && body.tool_choice.type === "tool") {
    request.tool_choice = { type: "function", name: body.tool_choice.name };
  }
  if (body.max_tokens !== undefined) {
    request.max_output_tokens = body.max_tokens;
  }
  if (body.reasoning_effort !== undefined) {
    // The request is built fresh here (no spread of `body`), so the raw
    // `reasoning_effort` key never lands on `request` in the first place —
    // this branch only needs to add the translated `reasoning` field.
    request.reasoning = { effort: body.reasoning_effort };
  }
  return request;
}

export function collectGrokResponse(payload = {}) {
  const content = [];
  const toolCalls = [];
  for (const item of payload.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") {
          content.push({ type: "text", text: part.text });
        }
      }
      continue;
    }
    if (item.type === "function_call") {
      const id = item.call_id || item.id;
      const input = parseArguments(item.arguments);
      content.push({ type: "tool_use", id, name: item.name, input });
      toolCalls.push({ id, name: item.name, input });
      continue;
    }
    // "reasoning" items (and any other unrecognized item types) are never
    // round-tripped back to the caller.
  }
  if (!content.length && !toolCalls.length) {
    throw new Error("Empty Grok response: no output content or tool calls.");
  }
  return {
    content,
    tool_calls: toolCalls,
    text: content.filter((item) => item.type === "text").map((item) => item.text).join(""),
    usage: payload.usage,
    model: payload.model ?? "",
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
  };
}

export function parseResponsesSseLines(lines) {
  let finalResponse = null;
  for (const raw of lines) {
    const line = String(raw ?? "");
    if (!line.startsWith("data: ")) {
      continue;
    }
    const payload = line.slice("data: ".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event?.type === "response.completed") {
      finalResponse = event.response ?? null;
    }
  }
  return finalResponse;
}

export class GrokOAuthResponsesTransport {}

function instructionsFrom(system) {
  if (!Array.isArray(system)) {
    return "";
  }
  return system.map((block) => stringValue(block?.text)).filter(Boolean).join("\n\n");
}

function messagesToInput(messages) {
  const input = [];
  for (const message of messages) {
    let textBlocks = [];
    const flushText = () => {
      if (textBlocks.length) {
        input.push({
          type: "message",
          role: message.role,
          content: textBlocks.map((text) => ({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text,
          })),
        });
        textBlocks = [];
      }
    };
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        textBlocks.push(block.text);
        continue;
      }
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        continue;
      }
      flushText();
      if (block.type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      }
    }
    flushText();
  }
  return input;
}

function parseArguments(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function stringValue(value) {
  return typeof value === "string" && value ? value : "";
}
