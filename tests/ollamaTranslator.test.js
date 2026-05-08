import { translateRequest, translateResponse } from '../src/lib/ollamaTranslator.js';

describe('ollamaTranslator', () => {
  describe('translateRequest', () => {
    it('passes through standard OpenAI fields', () => {
      const result = translateRequest({
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 1000,
        stream: false
      });

      expect(result.model).toBe('llama3');
      expect(result.messages).toHaveLength(1);
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(1000);
      expect(result.stream).toBe(false);
    });

    it('strips OpenAI-only fields', () => {
      const result = translateRequest({
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        logprobs: true,
        top_logprobs: 5,
        n: 2,
        best_of: 3,
        suffix: 'test',
        logit_bias: { '50256': -100 },
        user: 'agent-123'
      });

      expect(result.model).toBe('llama3');
      expect(result.logprobs).toBeUndefined();
      expect(result.top_logprobs).toBeUndefined();
      expect(result.n).toBeUndefined();
      expect(result.best_of).toBeUndefined();
      expect(result.suffix).toBeUndefined();
      expect(result.logit_bias).toBeUndefined();
      expect(result.user).toBeUndefined();
    });

    it('preserves Ollama-specific options', () => {
      const result = translateRequest({
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        options: { num_ctx: 4096, num_gpu: 1 }
      });

      expect(result.options).toEqual({ num_ctx: 4096, num_gpu: 1 });
    });
  });

  describe('translateResponse', () => {
    it('passes through standard OpenAI response', () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'llama3',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      };

      const result = translateResponse(openaiResponse);
      expect(result).toEqual(openaiResponse);
    });

    it('wraps Ollama native format response', () => {
      const ollamaResponse = {
        model: 'llama3',
        message: { role: 'assistant', content: 'Hello there!' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5
      };

      const result = translateResponse(ollamaResponse, 'llama3');
      expect(result.object).toBe('chat.completion');
      expect(result.choices[0].message.content).toBe('Hello there!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage.prompt_tokens).toBe(10);
      expect(result.usage.completion_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(15);
    });

    it('wraps response with fallback content from response field', () => {
      const ollamaResponse = {
        model: 'llama3',
        response: 'Raw response text',
        done: false
      };

      const result = translateResponse(ollamaResponse);
      expect(result.choices[0].message.content).toBe('Raw response text');
      expect(result.choices[0].finish_reason).toBeNull();
    });
  });
});
