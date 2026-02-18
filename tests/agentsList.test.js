import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/lib/db.js', () => ({
  validateApiKey: jest.fn(),
  listApiKeys: jest.fn(() => []),
  getMessagingMode: jest.fn(() => 'open'),
  getApiKeyByName: jest.fn(),
  createAgentMessage: jest.fn(),
  getAgentMessage: jest.fn(),
  getMessagesForAgent: jest.fn(() => []),
  markMessageRead: jest.fn(),
  createBroadcast: jest.fn(),
  addBroadcastRecipient: jest.fn(),
  listBroadcastsWithRecipients: jest.fn(() => []),
  getBroadcast: jest.fn(),
  getAccountsByService: jest.fn(() => ({})),
  getCookieSecret: jest.fn(() => 'test-secret'),
  hasAdminPassword: jest.fn(() => true),
  getSetting: jest.fn(),
  getPendingQueueCount: jest.fn(() => 0)
}));

jest.unstable_mockModule('../src/lib/agentNotifier.js', () => ({
  notifyAgentMessage: jest.fn()
}));

jest.unstable_mockModule('../src/lib/socketManager.js', () => ({
  emitCountUpdate: jest.fn()
}));

describe('GET /api/agents', () => {
  let app;
  let request;
  let db;

  beforeAll(async () => {
    const supertest = await import('supertest');
    request = supertest.default;
    db = await import('../src/lib/db.js');

    const express = (await import('express')).default;
    app = express();
    app.use(express.json());

    // Simple auth middleware
    const apiKeyAuth = async (req, _res, next) => {
      req.apiKeyName = 'TestAgent';
      next();
    };

    const agentsRouter = (await import('../src/routes/agents.js')).default;
    app.use('/api/agents', apiKeyAuth, agentsRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return an empty agents list', async () => {
    db.listApiKeys.mockReturnValue([]);
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
    expect(res.body.via).toBe('agentgate');
  });

  it('should return agents with name, bio, and enabled', async () => {
    db.listApiKeys.mockReturnValue([
      { name: 'Gimli', bio: 'A dwarf', enabled: 1 },
      { name: 'Legolas', bio: 'An elf', enabled: 0 },
      { name: 'Gandalf', bio: null, enabled: 1 }
    ]);
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([
      { name: 'Gimli', bio: 'A dwarf', enabled: true },
      { name: 'Legolas', bio: 'An elf', enabled: false },
      { name: 'Gandalf', bio: '', enabled: true }
    ]);
  });
});
