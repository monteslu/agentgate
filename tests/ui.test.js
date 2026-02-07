import { jest } from '@jest/globals';

// Mock the db module before importing anything that uses it
jest.unstable_mockModule('../src/lib/db.js', () => ({
  // API Key functions
  validateApiKey: jest.fn(),
  listApiKeys: jest.fn(() => []),
  createApiKey: jest.fn(),
  deleteApiKey: jest.fn(),
  getApiKeyById: jest.fn(),
  getApiKeyByName: jest.fn(),
  updateAgentWebhook: jest.fn(),
  
  // Avatar functions
  getAvatarsDir: jest.fn(() => '/tmp/avatars'),
  getAvatarFilename: jest.fn(() => null),
  deleteAgentAvatar: jest.fn(),
  listAvatars: jest.fn(() => []),
  
  // Account/Service functions
  getAccountsByService: jest.fn(() => ({})),
  getAccountCredentials: jest.fn(),
  setAccountCredentials: jest.fn(),
  deleteAccount: jest.fn(),
  deleteAccountById: jest.fn(),
  listAccounts: jest.fn(() => []),
  
  // Queue functions
  createQueueEntry: jest.fn(),
  getQueueEntry: jest.fn(),
  listQueueEntries: jest.fn(() => []),
  listQueueEntriesBySubmitter: jest.fn(() => []),
  listAllQueueEntries: jest.fn(() => []),
  updateQueueStatus: jest.fn(),
  updateQueueNotification: jest.fn(),
  listUnnotifiedEntries: jest.fn(() => []),
  deleteQueueEntry: jest.fn(),
  clearQueueByStatus: jest.fn(),
  clearCompletedQueue: jest.fn(),
  getPendingQueueCount: jest.fn(() => 0),
  getQueueCounts: jest.fn(() => ({ pending: 0, approved: 0, rejected: 0, completed: 0 })),
  
  // Auth functions
  getCookieSecret: jest.fn(() => 'test-secret'),
  hasAdminPassword: jest.fn(() => true),
  verifyAdminPassword: jest.fn(),
  setAdminPassword: jest.fn(),
  
  // Settings functions
  getSetting: jest.fn(),
  setSetting: jest.fn(),
  deleteSetting: jest.fn(),
  
  // Service Access Control
  listServicesWithAccess: jest.fn(() => []),
  getServiceAccess: jest.fn(() => ({ access_mode: 'all', agents: [] })),
  setServiceAccessMode: jest.fn(),
  setServiceAgentAccess: jest.fn(),
  setBypassAuth: jest.fn(),
  checkBypassAuth: jest.fn(() => false),
  
  // Messaging functions
  getMessagingMode: jest.fn(() => 'open'),
  setMessagingMode: jest.fn(),
  createAgentMessage: jest.fn(),
  getAgentMessage: jest.fn(),
  getMessagesForAgent: jest.fn(() => []),
  markMessageRead: jest.fn(),
  listPendingMessages: jest.fn(() => []),
  approveAgentMessage: jest.fn(),
  rejectAgentMessage: jest.fn(),
  listAgentMessages: jest.fn(() => []),
  deleteAgentMessage: jest.fn(),
  clearAgentMessagesByStatus: jest.fn(),
  getMessageCounts: jest.fn(() => ({ pending: 0, approved: 0, rejected: 0 })),
  
  // Broadcast functions
  listBroadcastsWithRecipients: jest.fn(() => []),
  listBroadcasts: jest.fn(() => []),
  createBroadcast: jest.fn(),
  addBroadcastRecipient: jest.fn(),
  clearBroadcasts: jest.fn(),
  deleteBroadcast: jest.fn(),
  getBroadcast: jest.fn(),
  
  // Queue visibility
  getSharedQueueVisibility: jest.fn(() => false),
  setSharedQueueVisibility: jest.fn(),
  getAgentWithdrawEnabled: jest.fn(() => false),
  setAgentWithdrawEnabled: jest.fn(),
  
  // Memento functions
  listMementos: jest.fn(() => []),
  getMementoById: jest.fn(),
  deleteMemento: jest.fn(),
  getMementoCounts: jest.fn(() => ({ total: 0, byAgent: [], last24h: 0 })),
  
  // Config functions
  getPendingMessagesCount: jest.fn(() => 0),
  getConfig: jest.fn(() => ({ messagingMode: 'open' }))
}));

// Mock hsyncManager
jest.unstable_mockModule('../src/lib/hsyncManager.js', () => ({
  connectHsync: jest.fn(),
  disconnectHsync: jest.fn(),
  getHsyncUrl: jest.fn(),
  isHsyncConnected: jest.fn(() => false)
}));

// Mock socket.io
jest.unstable_mockModule('socket.io', () => ({
  Server: jest.fn(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    engine: { on: jest.fn() }
  }))
}));

// Mock agentNotifier
jest.unstable_mockModule('../src/lib/agentNotifier.js', () => ({
  notifyAgent: jest.fn(() => Promise.resolve({ success: true })),
  notifyAgentQueueStatus: jest.fn(() => Promise.resolve({ success: true })),
  notifyAgentMessage: jest.fn(() => Promise.resolve({ success: true })),
  notifyMessageRejected: jest.fn(() => Promise.resolve({ success: true })),
  notifyAgentMessagesBatch: jest.fn(() => Promise.resolve({ success: true }))
}));

// Mock socketManager
jest.unstable_mockModule('../src/lib/socketManager.js', () => ({
  emitCountUpdate: jest.fn()
}));

// Mock queueExecutor
jest.unstable_mockModule('../src/lib/queueExecutor.js', () => ({
  executeQueueEntry: jest.fn(() => Promise.resolve({ success: true }))
}));

describe('UI Routes Integration', () => {
  let app;
  let request;
  let db;
  let authCookie;

  beforeAll(async () => {
    const supertest = await import('supertest');
    request = supertest.default;
    db = await import('../src/lib/db.js');

    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser('test-secret'));

    // Import and mount UI routes
    const uiRouter = (await import('../src/routes/ui/index.js')).default;
    app.use('/ui', uiRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authCookie = null;
  });

  // Helper to make authenticated requests
  const authenticatedRequest = (method, path) => {
    const req = request(app)[method](path);
    if (authCookie) {
      req.set('Cookie', authCookie);
    }
    return req;
  };

  // Helper to login and get auth cookie
  const login = async () => {
    db.verifyAdminPassword.mockResolvedValue(true);
    const res = await request(app)
      .post('/ui/login')
      .type('form')
      .send({ password: 'testpass' });
    
    // Extract cookie from response
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      authCookie = cookies[0];
    }
    return res;
  };

  describe('Auth Flow', () => {
    describe('GET /ui/login', () => {
      it('returns login page when not authenticated', async () => {
        const res = await request(app).get('/ui/login');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Login');
        expect(res.text).toContain('password');
      });

      it('redirects to /ui if already authenticated', async () => {
        await login();
        const res = await authenticatedRequest('get', '/ui/login');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/ui');
      });

      it('redirects to setup-password if no admin password set', async () => {
        db.hasAdminPassword.mockReturnValue(false);
        const res = await request(app).get('/ui/login');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/ui/setup-password');
        db.hasAdminPassword.mockReturnValue(true);
      });
    });

    describe('POST /ui/login', () => {
      it('sets auth cookie on valid password', async () => {
        db.verifyAdminPassword.mockResolvedValue(true);
        const res = await request(app)
          .post('/ui/login')
          .type('form')
          .send({ password: 'correct' });
        
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/ui');
        expect(res.headers['set-cookie']).toBeDefined();
      });

      it('returns error on invalid password', async () => {
        db.verifyAdminPassword.mockResolvedValue(false);
        const res = await request(app)
          .post('/ui/login')
          .type('form')
          .send({ password: 'wrong' });
        
        expect(res.status).toBe(200);
        expect(res.text).toContain('Invalid password');
      });

      it('returns error when password is missing', async () => {
        const res = await request(app)
          .post('/ui/login')
          .type('form')
          .send({});
        
        expect(res.status).toBe(200);
        expect(res.text).toContain('Password required');
      });
    });

    describe('POST /ui/logout', () => {
      it('clears auth cookie and redirects to login', async () => {
        await login();
        const res = await authenticatedRequest('post', '/ui/logout');
        
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/ui/login');
      });
    });
  });

  describe('Protected Routes', () => {
    describe('GET /ui/', () => {
      it('redirects to login when not authenticated', async () => {
        const res = await request(app).get('/ui/');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/ui/login');
      });

      it('returns dashboard when authenticated', async () => {
        await login();
        const res = await authenticatedRequest('get', '/ui/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('agentgate');
      });
    });
  });

  describe('Agent Keys (CRUD)', () => {
    beforeEach(async () => {
      await login();
      // Setup complete mock data for keys
      db.listApiKeys.mockReturnValue([
        { 
          id: '1', 
          name: 'TestAgent', 
          api_key: 'rms_test123',
          created_at: new Date().toISOString(),
          webhook_url: null,
          webhook_token: null
        }
      ]);
      db.getAvatarFilename.mockReturnValue(null);
    });

    describe('GET /ui/keys', () => {
      // TODO: Fix mock data structure - needs complete key object
      it.skip('lists agents when authenticated', async () => {
        const res = await authenticatedRequest('get', '/ui/keys');
        expect(res.status).toBe(200);
        expect(res.text).toContain('TestAgent');
      });
    });

    describe('POST /ui/keys/create', () => {
      // TODO: Fix mock - createApiKey return needs all properties
      it.skip('creates a new agent', async () => {
        db.createApiKey.mockReturnValue({ id: 'new-id', key: 'rms_test123', name: 'NewAgent' });
        
        const res = await authenticatedRequest('post', '/ui/keys/create')
          .type('form')
          .send({ name: 'NewAgent' });
        
        expect(res.status).toBe(302);
        expect(db.createApiKey).toHaveBeenCalledWith('NewAgent');
      });

      // TODO: Fix mock data for redirect after validation
      it.skip('rejects empty name', async () => {
        const res = await authenticatedRequest('post', '/ui/keys/create')
          .type('form')
          .send({ name: '' });
        
        // Empty name should redirect with error or return 400
        expect([302, 400]).toContain(res.status);
      });
    });

    describe('POST /ui/keys/:id/delete', () => {
      it('deletes an agent', async () => {
        db.deleteApiKey.mockReturnValue(true);
        
        const res = await authenticatedRequest('post', '/ui/keys/test-id/delete');
        
        expect(res.status).toBe(302);
        expect(db.deleteApiKey).toHaveBeenCalledWith('test-id');
      });
    });
  });

  describe('Queue Operations', () => {
    beforeEach(async () => {
      await login();
      // Setup complete mock data for queue
      db.listQueueEntries.mockReturnValue([
        { 
          id: 'q1', 
          service: 'github', 
          account_name: 'test',
          status: 'pending',
          comment: 'Test request',
          submitted_by: 'TestAgent',
          submitted_at: new Date().toISOString(),
          requests: JSON.stringify([{ method: 'POST', path: '/test' }])
        }
      ]);
    });

    describe('GET /ui/queue', () => {
      // TODO: Fix mock - queue entry needs complete structure with parsed requests
      it.skip('lists queue items', async () => {
        const res = await authenticatedRequest('get', '/ui/queue');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Test request');
      });
    });

    describe('POST /ui/queue/:id/approve', () => {
      it('approves a queue item', async () => {
        db.getQueueEntry.mockReturnValue({
          id: 'q1',
          status: 'pending',
          requests: []
        });
        db.updateQueueStatus.mockReturnValue(true);
        
        const res = await authenticatedRequest('post', '/ui/queue/q1/approve');
        
        // Should redirect after approval
        expect([200, 302]).toContain(res.status);
      });
    });

    describe('POST /ui/queue/:id/reject', () => {
      it('rejects a queue item with reason', async () => {
        db.getQueueEntry.mockReturnValue({
          id: 'q1',
          status: 'pending'
        });
        db.updateQueueStatus.mockReturnValue(true);
        
        const res = await authenticatedRequest('post', '/ui/queue/q1/reject')
          .type('form')
          .send({ reason: 'Not approved' });
        
        expect([200, 302]).toContain(res.status);
      });
    });
  });

  describe('Access Control', () => {
    beforeEach(async () => {
      await login();
    });

    describe('GET /ui/access', () => {
      it('shows access control page', async () => {
        db.listServicesWithAccess.mockReturnValue([
          { service: 'github', account_name: 'test' }
        ]);
        db.listApiKeys.mockReturnValue([
          { id: '1', name: 'Agent1' }
        ]);
        
        const res = await authenticatedRequest('get', '/ui/access');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Access Control');
      });
    });

    describe('POST /ui/access/:service/:account/mode', () => {
      // TODO: Fix - supertest headers not being set correctly for JSON response
      it.skip('updates access mode (JSON response)', async () => {
        const res = await authenticatedRequest('post', '/ui/access/github/test/mode')
          .set('Accept', 'application/json')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ mode: 'allowlist' }));
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.setServiceAccessMode).toHaveBeenCalledWith('github', 'test', 'allowlist');
      });

      it('updates access mode (redirect response)', async () => {
        const res = await authenticatedRequest('post', '/ui/access/github/test/mode')
          .type('form')
          .send({ mode: 'allowlist' });
        
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/ui/access');
      });
    });
  });

  describe('Messages', () => {
    beforeEach(async () => {
      await login();
    });

    describe('GET /ui/messages', () => {
      it('shows messages page', async () => {
        const res = await authenticatedRequest('get', '/ui/messages');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Messages');
      });
    });
  });
});


