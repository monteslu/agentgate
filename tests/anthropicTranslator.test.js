import { translateRequest, translateResponse } from '../src/lib/anthropicTranslator.js';

describe('anthropicTranslator', () => {
  describe('translateRequest', () => {
    it('should extract system messages to top-level system param', () => {
      const result = translateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' }
        ]
      });
      expect(result.system).toBe('You are helpful.');
      expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('should concatenate multiple system messages', () => {
      const result = translateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hi' }
        ]
      });
      expect(result.system).toBe('Be helpful.\nBe concise.');
    });

    it('should default max_tokens to 4096', () => {
      const result = translateRequest({ model: 'claude-sonnet-4-20250514', messages: [] });
      expect(result.max_tokens).toBe(4096);
    });

    it('should preserve provided max_tokens', () => {
      const result = translateRequest({ model: 'claude-sonnet-4-20250514', messages: [], max_tokens: 1000 });
      expect(result.max_tokens).toBe(1000);
    });

    it('should pass through temperature, top_p, stream', () => {
      const result = translateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: [],
        temperature: 0.5,
        top_p: 0.9,
        stream: true
      });
      expect(result.temperature).toBe(0.5);
      expect(result.top_p).toBe(0.9);
      expect(result.stream).toBe(true);
    });

    it('should map stop to stop_sequences array', () => {
      const result = translateRequest({ model: 'x', messages: [], stop: 'END' });
      expect(result.stop_sequences).toEqual(['END']);
    });

    it('should not include OpenAI-specific fields', () => {
      const result = translateRequest({
        model: 'x',
        messages: [],
        n: 2,
        frequency_penalty: 0.5,
        presence_penalty: 0.3,
        logprobs: true
      });
      expect(result.n).toBeUndefined();
      expect(result.frequency_penalty).toBeUndefined();
      expect(result.presence_penalty).toBeUndefined();
      expect(result.logprobs).toBeUndefined();
    });

    it('should not set system when no system messages exist', () => {
      const result = translateRequest({
        model: 'x',
        messages: [{ role: 'user', content: 'Hi' }]
      });
      expect(result.system).toBeUndefined();
    });
  });

  describe('translateResponse', () => {
    const anthropicRes = {
      id: 'msg_123',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'Hello there!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    };

    it('should translate to OpenAI format', () => {
      const result = translateResponse(anthropicRes);
      expect(result.id).toBe('msg_123');
      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.choices[0].message.content).toBe('Hello there!');
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].finish_reason).toBe('stop');
    });

    it('should translate usage fields', () => {
      const result = translateResponse(anthropicRes);
      expect(result.usage.prompt_tokens).toBe(10);
      expect(result.usage.completion_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(15);
    });

    it('should map max_tokens stop_reason to length', () => {
      const result = translateResponse({ ...anthropicRes, stop_reason: 'max_tokens' });
      expect(result.choices[0].finish_reason).toBe('length');
    });

    it('should handle empty content', () => {
      const result = translateResponse({ ...anthropicRes, content: [] });
      expect(result.choices[0].message.content).toBe('');
    });
  });
});
