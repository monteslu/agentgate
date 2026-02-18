// Anthropic ↔ OpenAI translation layer
// Translates OpenAI-format requests/responses to/from Anthropic Messages API

/**
 * Translate an OpenAI chat completion request body to Anthropic Messages API format.
 */
export function translateRequest(openaiBody) {
  const { messages = [], ...rest } = openaiBody;

  // Extract system messages → top-level system param
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const anthropicBody = {
    model: rest.model,
    max_tokens: rest.max_tokens || 4096,
    messages: nonSystemMessages
  };

  if (systemMessages.length > 0) {
    anthropicBody.system = systemMessages.map(m => m.content).join('\n');
  }

  // Pass through supported params
  if (rest.temperature !== undefined) anthropicBody.temperature = rest.temperature;
  if (rest.top_p !== undefined) anthropicBody.top_p = rest.top_p;
  if (rest.stop !== undefined) anthropicBody.stop_sequences = Array.isArray(rest.stop) ? rest.stop : [rest.stop];
  if (rest.stream !== undefined) anthropicBody.stream = rest.stream;

  return anthropicBody;
}

/**
 * Map Anthropic stop_reason to OpenAI finish_reason.
 */
function mapFinishReason(stopReason) {
  switch (stopReason) {
  case 'end_turn': return 'stop';
  case 'max_tokens': return 'length';
  case 'stop_sequence': return 'stop';
  default: return stopReason || 'stop';
  }
}

/**
 * Translate an Anthropic Messages API response to OpenAI chat completion format.
 */
export function translateResponse(anthropicRes) {
  const content = anthropicRes.content?.[0]?.text || '';

  return {
    id: anthropicRes.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicRes.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: mapFinishReason(anthropicRes.stop_reason)
    }],
    usage: {
      prompt_tokens: anthropicRes.usage?.input_tokens || 0,
      completion_tokens: anthropicRes.usage?.output_tokens || 0,
      total_tokens: (anthropicRes.usage?.input_tokens || 0) + (anthropicRes.usage?.output_tokens || 0)
    }
  };
}

/**
 * Transform an Anthropic SSE stream into OpenAI-format SSE chunks.
 * Reads from the upstream response body and writes to the Express response.
 */
export async function translateStream(upstreamRes, res) {
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let model = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;

        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        switch (currentEvent) {
        case 'message_start':
          model = data.message?.model || '';
          // Send initial chunk with role
          writeSSE(res, {
            id: data.message?.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
          });
          break;

        case 'content_block_delta':
          if (data.delta?.text) {
            writeSSE(res, {
              object: 'chat.completion.chunk',
              model,
              choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }]
            });
          }
          break;

        case 'message_delta':
          writeSSE(res, {
            object: 'chat.completion.chunk',
            model,
            choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(data.delta?.stop_reason) }],
            usage: data.usage ? {
              prompt_tokens: data.usage.input_tokens || 0,
              completion_tokens: data.usage.output_tokens || 0,
              total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
            } : undefined
          });
          break;

        case 'message_stop':
          res.write('data: [DONE]\n\n');
          break;

        default:
          break;
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.name !== 'AbortError') {
      console.error('[anthropic-translator] Stream error:', streamErr.message);
    }
  }
}

function writeSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
