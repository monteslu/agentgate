import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serviceInfo, readService } from '../src/routes/homeassistant.js';

// Mock the db module
vi.mock('../src/lib/db.js', () => ({
  getAccountCredentials: vi.fn()
}));

import { getAccountCredentials } from '../src/lib/db.js';

describe('homeassistant service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('serviceInfo', () => {
    it('should have correct structure', () => {
      expect(serviceInfo.key).toBe('homeassistant');
      expect(serviceInfo.authType).toBe('token');
      expect(serviceInfo.authMethods).toEqual(['token']);
      expect(serviceInfo.name).toBe('Home Assistant');
      expect(serviceInfo.examples).toBeDefined();
      expect(serviceInfo.examples.length).toBeGreaterThan(0);
      expect(serviceInfo.writeGuidelines).toBeDefined();
      expect(serviceInfo.writeGuidelines.length).toBeGreaterThan(0);
    });
  });

  describe('readService', () => {
    it('should return 401 when credentials are missing', async () => {
      getAccountCredentials.mockReturnValue(null);
      const result = await readService('test', 'states');
      expect(result.status).toBe(401);
      expect(result.data.error).toContain('not configured');
    });

    it('should return 401 when token is missing', async () => {
      getAccountCredentials.mockReturnValue({ host: 'http://localhost:8123' });
      const result = await readService('test', 'states');
      expect(result.status).toBe(401);
    });

    it('should return 401 when host is missing', async () => {
      getAccountCredentials.mockReturnValue({ token: 'abc123' });
      const result = await readService('test', 'states');
      expect(result.status).toBe(401);
    });

    it('should simplify states response', async () => {
      const mockStates = [
        {
          entity_id: 'light.living_room',
          state: 'on',
          last_changed: '2024-01-01T00:00:00Z',
          attributes: { friendly_name: 'Living Room Light', brightness: 255 },
          context: { id: '123' }
        },
        {
          entity_id: 'sensor.temperature',
          state: '72',
          last_changed: '2024-01-01T00:00:00Z',
          attributes: { friendly_name: 'Temperature', unit_of_measurement: '°F' },
          context: { id: '456' }
        }
      ];

      getAccountCredentials.mockReturnValue({ host: 'http://localhost:8123', token: 'test-token' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(mockStates)
      });

      const result = await readService('test', 'states');
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({
        entity_id: 'light.living_room',
        state: 'on',
        last_changed: '2024-01-01T00:00:00Z',
        friendly_name: 'Living Room Light'
      });
      // Should not include extra attributes
      expect(result.data[0].brightness).toBeUndefined();
      expect(result.data[0].context).toBeUndefined();
    });

    it('should simplify single state response', async () => {
      const mockState = {
        entity_id: 'light.living_room',
        state: 'on',
        last_changed: '2024-01-01T00:00:00Z',
        attributes: { friendly_name: 'Living Room Light', brightness: 255 }
      };

      getAccountCredentials.mockReturnValue({ host: 'http://localhost:8123', token: 'test-token' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(mockState)
      });

      const result = await readService('test', 'states/light.living_room');
      expect(result.status).toBe(200);
      expect(result.data.entity_id).toBe('light.living_room');
      expect(result.data.friendly_name).toBe('Living Room Light');
      expect(result.data.brightness).toBeUndefined();
    });

    it('should return raw data when raw=true', async () => {
      const mockStates = [
        {
          entity_id: 'light.living_room',
          state: 'on',
          last_changed: '2024-01-01T00:00:00Z',
          attributes: { friendly_name: 'Living Room Light', brightness: 255 },
          context: { id: '123' }
        }
      ];

      getAccountCredentials.mockReturnValue({ host: 'http://localhost:8123', token: 'test-token' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(mockStates)
      });

      const result = await readService('test', 'states', { raw: true });
      expect(result.data[0].attributes).toBeDefined();
      expect(result.data[0].context).toBeDefined();
    });

    it('should handle HA offline/errors', async () => {
      getAccountCredentials.mockReturnValue({ host: 'http://localhost:8123', token: 'test-token' });
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(readService('test', 'states')).rejects.toThrow('ECONNREFUSED');
    });

    it('should handle binary camera proxy responses', async () => {
      const mockBuffer = new ArrayBuffer(8);
      getAccountCredentials.mockReturnValue({ host: 'http://localhost:8123', token: 'test-token' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: () => Promise.resolve(mockBuffer)
      });

      const result = await readService('test', 'camera_proxy/camera.front_door', { raw: true });
      expect(result.binary).toBe(true);
      expect(result.contentType).toBe('image/jpeg');
    });

    it('should strip trailing slashes from host', async () => {
      getAccountCredentials.mockReturnValue({ host: 'http://localhost:8123/', token: 'test-token' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({})
      });

      await readService('test', 'config');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8123/api/config',
        expect.any(Object)
      );
    });
  });
});
