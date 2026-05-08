import { translateRequest, translateResponse, buildGeminiUrl } from '../src/lib/geminiTranslator.js';

describe('geminiTranslator', () => {
  describe('translateRequest', () => {
    it('converts messages with system extraction', () => {
      const result = translateRequest({
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'How are you?' }
        ],
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9,
        stop: ['END']
      });

      expect(result.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
      expect(result.contents).toHaveLength(3);
      expect(result.contents[0].role).toBe('user');
      expect(result.contents[1].role).toBe('model'); // assistant → model
      expect(result.contents[2].role).toBe('user');
      expect(result.generationConfig.maxOutputTokens).toBe(1000);
      expect(result.generationConfig.temperature).toBe(0.7);
      expect(result.generationConfig.topP).toBe(0.9);
      expect(result.generationConfig.stopSequences).toEqual(['END']);
      expect(result.model).toBeUndefined(); // model not in body
    });

    it('omits systemInstruction when no system messages', () => {
      const result = translateRequest({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'Hi' }]
      });
      expect(result.systemInstruction).toBeUndefined();
      expect(result.contents).toHaveLength(1);
    });

    it('omits generationConfig when no params', () => {
      const result = translateRequest({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'Hi' }]
      });
      expect(result.generationConfig).toBeUndefined();
    });

    it('handles stop as string', () => {
      const result = translateRequest({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'Hi' }],
        stop: 'STOP'
      });
      expect(result.generationConfig.stopSequences).toEqual(['STOP']);
    });
  });

  describe('translateResponse', () => {
    it('converts Gemini response to OpenAI format', () => {
      const result = translateResponse({
        candidates: [{
          content: { parts: [{ text: 'Hello!' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5
        }
      }, 'gemini-2.0-flash');

      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('gemini-2.0-flash');
      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage.prompt_tokens).toBe(10);
      expect(result.usage.completion_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(15);
    });

    it('maps MAX_TOKENS finish reason', () => {
      const result = translateResponse({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }]
      }, 'gemini-2.0-flash');
      expect(result.choices[0].finish_reason).toBe('length');
    });

    it('maps SAFETY finish reason', () => {
      const result = translateResponse({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }]
      }, 'gemini-2.0-flash');
      expect(result.choices[0].finish_reason).toBe('content_filter');
    });

    it('handles missing fields gracefully', () => {
      const result = translateResponse({}, 'gemini-2.0-flash');
      expect(result.choices[0].message.content).toBe('');
      expect(result.usage.prompt_tokens).toBe(0);
    });
  });

  describe('buildGeminiUrl', () => {
    it('builds non-streaming URL', () => {
      const url = buildGeminiUrl('https://generativelanguage.googleapis.com', 'gemini-2.0-flash', false);
      expect(url).toBe('https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent');
    });

    it('builds streaming URL', () => {
      const url = buildGeminiUrl('https://generativelanguage.googleapis.com', 'gemini-2.0-flash', true);
      expect(url).toBe('https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:streamGenerateContent?alt=sse');
    });

    it('strips trailing slashes from base URL', () => {
      const url = buildGeminiUrl('https://example.com/', 'model', false);
      expect(url).toBe('https://example.com/v1/models/model:generateContent');
    });
  });
});
