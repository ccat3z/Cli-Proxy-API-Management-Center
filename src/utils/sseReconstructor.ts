import { parse as parsePartialJson } from 'partial-json';

interface SSEEvent {
  event?: string;
  data: string;
  parsedData: unknown;
}

export interface SSEReconstructionResult {
  assembled: unknown;
  eventCount: number;
  format: 'anthropic' | 'openai-chat' | 'openai-responses' | 'generic' | 'none';
}

export function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = text.split(/\n\n+/);

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    let eventType: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) {
        eventType = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        dataLines.push(trimmed.slice(5).trim());
      }
    }

    if (dataLines.length > 0) {
      const dataStr = dataLines.join('\n');
      if (dataStr === '[DONE]') continue;
      let parsedData: unknown;
      try {
        parsedData = parsePartialJson(dataStr);
      } catch {
        parsedData = dataStr;
      }
      events.push({ event: eventType, data: dataStr, parsedData });
    }
  }

  return events;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reconstructAnthropic(events: SSEEvent[]): object | null {
  const hasMessageStart = events.some(e => e.event === 'message_start');
  if (!hasMessageStart) return null;

  let message: Record<string, unknown> | null = null;
  const contentBlocks: Map<number, Record<string, unknown>> = new Map();

  for (const event of events) {
    if (!isObject(event.parsedData)) continue;
    const data = event.parsedData;

    switch (event.event) {
      case 'message_start': {
        if (isObject(data.message)) {
          message = { ...data.message };
          if (Array.isArray(message!.content)) {
            message!.content.forEach((item: unknown, i: number) => {
              if (isObject(item)) contentBlocks.set(i, { ...item });
            });
          }
        }
        break;
      }
      case 'content_block_start': {
        const index = data.index as number | undefined;
        if (index !== undefined && isObject(data.content_block)) {
          contentBlocks.set(index, { ...data.content_block });
        }
        break;
      }
      case 'content_block_delta': {
        const index = data.index as number | undefined;
        if (index !== undefined && isObject(data.delta)) {
          const delta = data.delta;
          const block = contentBlocks.get(index) ?? {};

          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = (block.text as string ?? '') + delta.text;
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            block.partial_json = (block.partial_json as string ?? '') + delta.partial_json;
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = (block.thinking as string ?? '') + delta.thinking;
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature = (block.signature as string ?? '') + delta.signature;
          } else {
            for (const [key, value] of Object.entries(delta)) {
              if (key === 'type') continue;
              if (typeof value === 'string') {
                block[key] = (block[key] as string ?? '') + value;
              } else {
                block[key] = value;
              }
            }
          }
          contentBlocks.set(index, block);
        }
        break;
      }
      case 'content_block_stop':
        break;
      case 'message_delta': {
        if (message) {
          if (isObject(data.delta)) Object.assign(message, data.delta);
          if (isObject(data.usage)) {
            message.usage = { ...((message.usage as Record<string, unknown>) ?? {}), ...data.usage };
          }
        }
        break;
      }
      case 'message_stop':
        break;
      case 'ping':
        break;
    }
  }

  if (!message) return null;

  const sortedIndices = Array.from(contentBlocks.keys()).sort((a, b) => a - b);
  message.content = sortedIndices.map(i => {
    const block = { ...contentBlocks.get(i)! };
    if ('partial_json' in block) {
      try {
        block.input = parsePartialJson(block.partial_json as string);
      } catch { /* keep as-is */ }
      delete block.partial_json;
    }
    return block;
  });

  return message;
}

function reconstructOpenAIChat(events: SSEEvent[]): object | null {
  const hasOpenAIFormat = events.some(e => {
    if (!isObject(e.parsedData)) return false;
    return e.parsedData.object === 'chat.completion.chunk';
  });
  if (!hasOpenAIFormat) return null;

  let result: Record<string, unknown> = {};
  const choices: Map<number, Record<string, unknown>> = new Map();

  for (const event of events) {
    if (!isObject(event.parsedData)) continue;
    const data = event.parsedData;

    if (!result.id) {
      result = {
        id: data.id,
        object: 'chat.completion',
        created: data.created,
        model: data.model,
        service_tier: data.service_tier,
        system_fingerprint: data.system_fingerprint,
      };
    }

    const dataChoices = data.choices as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(dataChoices)) {
      for (const choice of dataChoices) {
        const index = (choice.index as number) ?? 0;
        const delta = choice.delta as Record<string, unknown> | undefined;
        const finishReason = choice.finish_reason as string | null | undefined;

        let existing = choices.get(index);
        if (!existing) {
          existing = { index, message: {} as Record<string, unknown> };
          choices.set(index, existing);
        }

        if (delta) {
          const msg = existing.message as Record<string, unknown>;
          if (delta.role) msg.role = delta.role;
          if (typeof delta.content === 'string') {
            msg.content = (msg.content as string ?? '') + delta.content;
          }
          if (typeof delta.reasoning_content === 'string') {
            msg.reasoning_content = (msg.reasoning_content as string ?? '') + delta.reasoning_content;
          }
          if (delta.refusal) {
            msg.refusal = (msg.refusal as string ?? '') + (delta.refusal as string);
          }
          if (Array.isArray(delta.tool_calls)) {
            const existingToolCalls = (msg.tool_calls as Array<Record<string, unknown>>) ?? [];
            for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
              const tcIndex = (tc.index as number) ?? existingToolCalls.length;
              while (existingToolCalls.length <= tcIndex) {
                existingToolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
              }
              const existingTC = existingToolCalls[tcIndex];
              if (tc.id) existingTC.id = tc.id;
              if (tc.type) existingTC.type = tc.type;
              if (isObject(tc.function)) {
                const fn = tc.function;
                const existingFn = existingTC.function as Record<string, unknown>;
                if (fn.name) existingFn.name = (existingFn.name as string ?? '') + (fn.name as string);
                if (fn.arguments) existingFn.arguments = (existingFn.arguments as string ?? '') + (fn.arguments as string);
              }
            }
            msg.tool_calls = existingToolCalls;
          }
        }

        if (finishReason) existing.finish_reason = finishReason;
      }
    }

    if (data.usage) result.usage = data.usage;
  }

  result.choices = Array.from(choices.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => {
      const choice = { ...v };
      const msg = choice.message as Record<string, unknown>;
      if (Array.isArray(msg.tool_calls)) {
        choice.message = {
          ...msg,
          tool_calls: msg.tool_calls.map((tc: Record<string, unknown>) => {
            const fn = tc.function as Record<string, unknown>;
            if (fn && typeof fn.arguments === 'string' && fn.arguments) {
              try {
                return { ...tc, function: { ...fn, arguments: parsePartialJson(fn.arguments) } };
              } catch {
                return tc;
              }
            }
            return tc;
          }),
        };
      }
      return choice;
    });

  return result;
}

function reconstructOpenAIResponses(events: SSEEvent[]): object | null {
  const isResponsesAPI = events.some(e => {
    if (!isObject(e.parsedData)) return false;
    const type = e.parsedData.type as string | undefined;
    return !!type?.startsWith('response.');
  });
  if (!isResponsesAPI) return null;

  let response: Record<string, unknown> | null = null;
  const textBuffers: Map<string, string> = new Map();
  const fnArgBuffers: Map<string, string> = new Map();

  for (const event of events) {
    if (!isObject(event.parsedData)) continue;
    const data = event.parsedData;
    const type = (event.event ?? data.type) as string;

    switch (type) {
      case 'response.created':
        if (isObject(data.response)) response = { ...data.response };
        break;
      case 'response.in_progress':
        if (response && isObject(data.response)) Object.assign(response, data.response);
        break;
      case 'response.output_item.added':
        if (response && isObject(data.item)) {
          const output = (response.output as Array<Record<string, unknown>>) ?? [];
          output.push({ ...data.item });
          response.output = output;
        }
        break;
      case 'response.content_part.added':
        if (response && isObject(data.part)) {
          const output = (response.output as Array<Record<string, unknown>>) ?? [];
          const itemIdx = (data.item_index as number) ?? 0;
          if (output[itemIdx]) {
            const content = (output[itemIdx].content as Array<Record<string, unknown>>) ?? [];
            content.push({ ...data.part });
            output[itemIdx].content = content;
          }
        }
        break;
      case 'response.output_text.delta': {
        const key = `${data.item_index ?? 0}-${data.content_index ?? 0}`;
        textBuffers.set(key, (textBuffers.get(key) ?? '') + (data.delta as string ?? ''));
        break;
      }
      case 'response.output_text.done':
        if (response) {
          const output = (response.output as Array<Record<string, unknown>>) ?? [];
          const itemIdx = (data.item_index as number) ?? 0;
          const contentIdx = (data.content_index as number) ?? 0;
          const key = `${itemIdx}-${contentIdx}`;
          if (output[itemIdx]) {
            const content = (output[itemIdx].content as Array<Record<string, unknown>>) ?? [];
            if (content[contentIdx]) {
              content[contentIdx].text = textBuffers.get(key) ?? (data.text as string ?? '');
            }
          }
        }
        break;
      case 'response.function_call_arguments.delta': {
        const key = `${data.item_index ?? 0}`;
        fnArgBuffers.set(key, (fnArgBuffers.get(key) ?? '') + (data.delta as string ?? ''));
        break;
      }
      case 'response.function_call_arguments.done':
        if (response) {
          const output = (response.output as Array<Record<string, unknown>>) ?? [];
          const itemIdx = (data.item_index as number) ?? 0;
          const key = `${itemIdx}`;
          if (output[itemIdx]) {
            output[itemIdx].arguments = fnArgBuffers.get(key) ?? (data.arguments as string ?? '');
          }
        }
        break;
      case 'response.completed':
        if (response && isObject(data.response)) Object.assign(response, data.response);
        break;
    }
  }

  return response;
}

export function reconstructSSEResponse(text: string): SSEReconstructionResult {
  const events = parseSSEEvents(text);
  if (events.length === 0) {
    return { assembled: null, eventCount: 0, format: 'none' };
  }

  const anthropicResult = reconstructAnthropic(events);
  if (anthropicResult) {
    return { assembled: anthropicResult, eventCount: events.length, format: 'anthropic' };
  }

  const openaiChatResult = reconstructOpenAIChat(events);
  if (openaiChatResult) {
    return { assembled: openaiChatResult, eventCount: events.length, format: 'openai-chat' };
  }

  const openaiResponsesResult = reconstructOpenAIResponses(events);
  if (openaiResponsesResult) {
    return { assembled: openaiResponsesResult, eventCount: events.length, format: 'openai-responses' };
  }

  return {
    assembled: events.map(e => e.parsedData),
    eventCount: events.length,
    format: 'generic',
  };
}

export function extractSSEBody(body: string): { beforeSSE: string; sseText: string } {
  const lines = body.split('\n');
  let bodyStartIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'Body:') {
      bodyStartIdx = i + 1;
      break;
    }
  }

  if (bodyStartIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('event:') || lines[i].trim().startsWith('data:')) {
        bodyStartIdx = i;
        break;
      }
    }
    if (bodyStartIdx === -1) {
      return { beforeSSE: body, sseText: '' };
    }
  }

  const beforeSSE = lines.slice(0, bodyStartIdx).join('\n');
  const sseText = lines.slice(bodyStartIdx).join('\n');
  return { beforeSSE, sseText };
}

export function isSSEResponseSection(title: string, body: string): boolean {
  const t = title.toUpperCase().trim();
  const isResponseSection =
    t === 'RESPONSE' ||
    t.startsWith('API RESPONSE') ||
    t.startsWith('API ERROR RESPONSE');
  if (!isResponseSection) return false;

  const { sseText } = extractSSEBody(body);
  return sseText.includes('data:');
}
