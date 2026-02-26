import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/lib/db.js', () => ({
  getAccountCredentials: jest.fn()
}));

const { getAccountCredentials } = await import('../src/lib/db.js');
const { serviceInfo, readService } = await import('../src/routes/plivo.js');

describe('plivo service', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    delete globalThis.fetch;
  });

  describe('serviceInfo', () => {
    it('should have correct structure', () => {
      expect(serviceInfo.key).toBe('plivo');
      expect(serviceInfo.authType).toBe('basic');
      expect(serviceInfo.authMethods).toEqual(['basic']);
      expect(serviceInfo.name).toBe('Plivo');
      expect(serviceInfo.examples).toBeDefined();
      expect(serviceInfo.examples.length).toBeGreaterThan(0);
    });
  });

  describe('readService', () => {
    it('should return 401 when credentials are missing', async () => {
      getAccountCredentials.mockReturnValue(null);
      const result = await readService('test', 'Message/');
      expect(result.status).toBe(401);
      expect(result.data.error).toContain('not configured');
    });

    it('should return 401 when authId is missing', async () => {
      getAccountCredentials.mockReturnValue({ authToken: 'token123' });
      const result = await readService('test', 'Message/');
      expect(result.status).toBe(401);
    });

    it('should return 401 when authToken is missing', async () => {
      getAccountCredentials.mockReturnValue({ authId: 'id123' });
      const result = await readService('test', 'Message/');
      expect(result.status).toBe(401);
    });

    it('should fetch messages with basic auth', async () => {
      const mockMessages = { objects: [{ message_uuid: 'abc123', from_number: '+1234567890' }] };
      getAccountCredentials.mockReturnValue({ authId: 'MYAUTHID', authToken: 'MYAUTHTOKEN' });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockMessages)
      });

      const result = await readService('test', 'Message/');
      expect(result.status).toBe(200);
      expect(result.data).toEqual(mockMessages);

      const expectedAuth = Buffer.from('MYAUTHID:MYAUTHTOKEN').toString('base64');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.plivo.com/v1/Account/MYAUTHID/Message/',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Basic ${expectedAuth}`
          })
        })
      );
    });

    it('should fetch single message by uuid', async () => {
      const mockMessage = { message_uuid: 'abc123', from_number: '+1234567890', text: 'Hello' };
      getAccountCredentials.mockReturnValue({ authId: 'MYAUTHID', authToken: 'MYAUTHTOKEN' });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockMessage)
      });

      const result = await readService('test', 'Message/abc123/');
      expect(result.status).toBe(200);
      expect(result.data.message_uuid).toBe('abc123');
    });

    it('should pass query parameters', async () => {
      getAccountCredentials.mockReturnValue({ authId: 'MYAUTHID', authToken: 'MYAUTHTOKEN' });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ objects: [] })
      });

      await readService('test', 'Message/', { query: { limit: '10', offset: '0' } });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.any(Object)
      );
    });

    it('should handle API errors', async () => {
      getAccountCredentials.mockReturnValue({ authId: 'MYAUTHID', authToken: 'MYAUTHTOKEN' });
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(readService('test', 'Message/')).rejects.toThrow('Network error');
    });

    it('should fetch account info', async () => {
      const mockAccount = { auth_id: 'MYAUTHID', name: 'Test Account' };
      getAccountCredentials.mockReturnValue({ authId: 'MYAUTHID', authToken: 'MYAUTHTOKEN' });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockAccount)
      });

      const result = await readService('test', '');
      expect(result.status).toBe(200);
      expect(result.data.auth_id).toBe('MYAUTHID');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.plivo.com/v1/Account/MYAUTHID/',
        expect.any(Object)
      );
    });
  });
});
