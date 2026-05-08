// Ollama ↔ OpenAI translation layer
// Ollama is OpenAI-compatible, so this is mostly passthrough with cleanup.

// OpenAI-only fields that Ollama doesn't understand
const STRIP_FIELDS = [
  'logprobs', 'top_logprobs', 'n', 'best_of',
  'suffix', 'logit_bias', 'user'
];

/**
 * Translate an OpenAI chat completion request body for Ollama.
 * Mostly passthrough — strip OpenAI-only fields, pass Ollama extras through.
 */
export function translateRequest(openaiBody) {
  const body = { ...openaiBody };

  for (const field of STRIP_FIELDS) {
    delete body[field];
  }

  return body;
}

/**
 * Translate an Ollama response to OpenAI chat completion format.
 * Ollama already returns OpenAI format, but wrap if missing standard envelope.
 */
export function translateResponse(data, model) {
  // Already has OpenAI envelope
  if (data.object === 'chat.completion' && data.choices) {
    return data;
  }

  // Ollama native format (non-OpenAI-compat endpoint) — wrap it
  const content = data.message?.content || data.response || '';
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || data.model || 'ollama',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: data.done ? 'stop' : null
    }],
    usage: {
      prompt_tokens: data.prompt_eval_count || 0,
      completion_tokens: data.eval_count || 0,
      total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
    }
  };
}
