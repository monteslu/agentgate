import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/lib/db.js', () => ({
  getAccountCredentials: jest.fn()
}));

const { getAccountCredentials } = await import('../src/lib/db.js');
const { serviceInfo, readService } = await import('../src/routes/twilio.js');

describe('twilio service', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    delete globalThis.fetch;
  });

  describe('serviceInfo', () => {
    it('should have correct structure', () => {
      expect(serviceInfo.key).toBe('twilio');
      expect(serviceInfo.authType).toBe('basic');
      expect(serviceInfo.authMethods).toEqual(['basic']);
      expect(serviceInfo.name).toBe('Twilio');
      expect(serviceInfo.examples).toBeDefined();
      expect(serviceInfo.examples.length).toBeGreaterThan(0);
      expect(serviceInfo.writeGuidelines).toBeDefined();
      expect(serviceInfo.writeGuidelines.length).toBeGreaterThan(0);
    });
  });

  describe('readService', () => {
    it('should return 401 when credentials are missing', async () => {
      getAccountCredentials.mockReturnValue(null);
      const result = await readService('test', 'Messages.json');
      expect(result.status).toBe(401);
      expect(result.data.error).toContain('not configured');
    });

    it('should return 401 when accountSid is missing', async () => {
      getAccountCredentials.mockReturnValue({ authToken: 'token123' });
      const result = await readService('test', 'Messages.json');
      expect(result.status).toBe(401);
    });

    it('should return 401 when authToken is missing', async () => {
      getAccountCredentials.mockReturnValue({ accountSid: 'AC123' });
      const result = await readService('test', 'Messages.json');
      expect(result.status).toBe(401);
    });

    it('should fetch messages with basic auth', async () => {
      getAccountCredentials.mockReturnValue({
        accountSid: 'AC123',
        authToken: 'token456'
      });

      const mockMessages = {
        messages: [{ sid: 'SM1', body: 'Hello' }]
      };

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockMessages
      });

      const result = await readService('test', 'Messages.json');
      expect(result.status).toBe(200);
      expect(result.data).toEqual(mockMessages);

      const fetchCall = globalThis.fetch.mock.calls[0];
      expect(fetchCall[0]).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
      const expectedAuth = Buffer.from('AC123:token456').toString('base64');
      expect(fetchCall[1].headers['Authorization']).toBe(`Basic ${expectedAuth}`);
    });

    it('should pass query parameters', async () => {
      getAccountCredentials.mockReturnValue({
        accountSid: 'AC123',
        authToken: 'token456'
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ messages: [] })
      });

      await readService('test', 'Messages.json', { query: { PageSize: '10' } });

      const fetchCall = globalThis.fetch.mock.calls[0];
      expect(fetchCall[0]).toContain('PageSize=10');
    });

    it('should handle API errors', async () => {
      getAccountCredentials.mockReturnValue({
        accountSid: 'AC123',
        authToken: 'badtoken'
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ code: 20003, message: 'Authenticate' })
      });

      const result = await readService('test', 'Messages.json');
      expect(result.status).toBe(401);
      expect(result.data.code).toBe(20003);
    });
  });
});
