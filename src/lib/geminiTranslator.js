// Gemini ↔ OpenAI translation layer
// Translates OpenAI-format requests/responses to/from Google Gemini API

/**
 * Translate an OpenAI chat completion request body to Gemini format.
 * The model is used in the URL path, not in the body.
 */
export function translateRequest(openaiBody) {
  const { messages = [], ...rest } = openaiBody;

  // Extract system messages → systemInstruction
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const geminiBody = {};

  if (systemMessages.length > 0) {
    const systemText = systemMessages.map(m => m.content).join('\n');
    geminiBody.systemInstruction = { parts: [{ text: systemText }] };
  }

  // Convert messages → contents (assistant → model)
  geminiBody.contents = nonSystemMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : m.role,
    parts: [{ text: m.content || '' }]
  }));

  // Build generationConfig from OpenAI params
  const generationConfig = {};
  if (rest.max_tokens !== undefined) generationConfig.maxOutputTokens = rest.max_tokens;
  if (rest.temperature !== undefined) generationConfig.temperature = rest.temperature;
  if (rest.top_p !== undefined) generationConfig.topP = rest.top_p;
  if (rest.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(rest.stop) ? rest.stop : [rest.stop];
  }

  if (Object.keys(generationConfig).length > 0) {
    geminiBody.generationConfig = generationConfig;
  }

  return geminiBody;
}

/**
 * Build the upstream URL for Gemini requests.
 */
export function buildGeminiUrl(baseUrl, model, isStreaming) {
  const base = baseUrl.replace(/\/+$/, '');
  if (isStreaming) {
    return `${base}/v1/models/${model}:streamGenerateContent?alt=sse`;
  }
  return `${base}/v1/models/${model}:generateContent`;
}

/**
 * Map Gemini finishReason to OpenAI finish_reason.
 */
function mapFinishReason(reason) {
  switch (reason) {
  case 'STOP': return 'stop';
  case 'MAX_TOKENS': return 'length';
  case 'SAFETY': return 'content_filter';
  default: return reason ? reason.toLowerCase() : 'stop';
  }
}

/**
 * Translate a Gemini response to OpenAI chat completion format.
 */
export function translateResponse(geminiRes, model) {
  const candidate = geminiRes.candidates?.[0];
  const content = candidate?.content?.parts?.[0]?.text || '';
  const promptTokens = geminiRes.usageMetadata?.promptTokenCount || 0;
  const completionTokens = geminiRes.usageMetadata?.candidatesTokenCount || 0;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'gemini',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: mapFinishReason(candidate?.finishReason)
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

/**
 * Transform a Gemini SSE stream into OpenAI-format SSE chunks.
 */
export async function translateStream(upstreamRes, res, model) {
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sentRole = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;

        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        const candidate = data.candidates?.[0];
        if (!candidate) continue;

        const text = candidate.content?.parts?.[0]?.text;
        const finishReason = candidate.finishReason;

        if (text !== undefined) {
          const delta = { content: text };
          if (!sentRole) {
            delta.role = 'assistant';
            sentRole = true;
          }
          writeSSE(res, {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || 'gemini',
            choices: [{ index: 0, delta, finish_reason: null }]
          });
        }

        if (finishReason && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
          writeSSE(res, {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || 'gemini',
            choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(finishReason) }]
          });
          res.write('data: [DONE]\n\n');
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.name !== 'AbortError') {
      console.error('[gemini-translator] Stream error:', streamErr.message);
    }
  }
}

function writeSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
