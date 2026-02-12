// ==========================================
// Tests for MCP Session Persistence
// tests/mcp-sessions.test.js
// For issue #219
// ==========================================

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  upsertMcpSession,
  touchMcpSession,
  getMcpSession,
  listMcpSessions,
  deleteMcpSession,
  deleteMcpSessionsForAgent,
  deleteStaleMcpSessions,
  getMcpSessionCounts,
  getMcpSessionCount
} from '../src/lib/db.js';

describe('MCP Session Persistence', () => {
  const testSessionId1 = 'test-session-' + Date.now() + '-1';
  const testSessionId2 = 'test-session-' + Date.now() + '-2';
  const testSessionId3 = 'test-session-' + Date.now() + '-3';
  const testAgent1 = 'TestAgent1';
  const testAgent2 = 'TestAgent2';

  afterEach(() => {
    // Cleanup test sessions
    deleteMcpSession(testSessionId1);
    deleteMcpSession(testSessionId2);
    deleteMcpSession(testSessionId3);
  });

  describe('upsertMcpSession', () => {
    it('should create a new session', () => {
      const result = upsertMcpSession(testSessionId1, testAgent1);
      expect(result.changes).toBe(1);

      const session = getMcpSession(testSessionId1);
      expect(session).toBeTruthy();
      expect(session.session_id).toBe(testSessionId1);
      expect(session.agent_id).toBe(testAgent1);
      expect(session.created_at).toBeTruthy();
      expect(session.last_seen).toBeTruthy();
    });

    it('should update last_seen on upsert', async () => {
      upsertMcpSession(testSessionId1, testAgent1);
      const session1 = getMcpSession(testSessionId1);
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));
      
      upsertMcpSession(testSessionId1, testAgent1);
      const session2 = getMcpSession(testSessionId1);
      
      expect(session2.last_seen).not.toBe(session1.last_seen);
      expect(session2.created_at).toBe(session1.created_at); // created_at should not change
    });
  });

  describe('touchMcpSession', () => {
    it('should update last_seen timestamp', async () => {
      upsertMcpSession(testSessionId1, testAgent1);
      const session1 = getMcpSession(testSessionId1);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      touchMcpSession(testSessionId1);
      const session2 = getMcpSession(testSessionId1);
      
      expect(session2.last_seen).not.toBe(session1.last_seen);
    });
  });

  describe('getMcpSession', () => {
    it('should return null for non-existent session', () => {
      const session = getMcpSession('non-existent-session-id');
      expect(session).toBeUndefined();
    });

    it('should return session data for existing session', () => {
      upsertMcpSession(testSessionId1, testAgent1);
      const session = getMcpSession(testSessionId1);
      
      expect(session).toBeTruthy();
      expect(session.session_id).toBe(testSessionId1);
      expect(session.agent_id).toBe(testAgent1);
    });
  });

  describe('listMcpSessions', () => {
    it('should list all sessions', () => {
      upsertMcpSession(testSessionId1, testAgent1);
      upsertMcpSession(testSessionId2, testAgent1);
      upsertMcpSession(testSessionId3, testAgent2);

      const sessions = listMcpSessions();
      const testSessions = sessions.filter(s => 
        [testSessionId1, testSessionId2, testSessionId3].includes(s.session_id)
      );
      
      expect(testSessions.length).toBe(3);
    });

    it('should filter by agent name', () => {
      upsertMcpSession(testSessionId1, testAgent1);
      upsertMcpSession(testSessionId2, testAgent1);
      upsertMcpSession(testSessionId3, testAgent2);

      const sessions = listMcpSessions(testAgent1);
      const testSessions = sessions.filter(s => 
        [testSessionId1, testSessionId2].includes(s.session_id)
      );
      
      expect(testSessions.length).toBe(2);
      testSessions.forEach(s => {
        expect(s.agent_id).toBe(testAgent1);
      });
    });
  });

  describe('deleteMcpSession', () => {
    it('should delete a session', () => {
      upsertMcpSession(testSessionId1, testAgent1);
      expect(getMcpSession(testSessionId1)).toBeTruthy();
      
      deleteMcpSession(testSessionId1);
      expect(getMcpSession(testSessionId1)).toBeUndefined();
    });
  });

  describe('deleteMcpSessionsForAgent', () => {
    it('should delete all sessions for an agent', () => {
      upsertMcpSession(testSessionId1, testAgent1);
      upsertMcpSession(testSessionId2, testAgent1);
      upsertMcpSession(testSessionId3, testAgent2);

      const result = deleteMcpSessionsForAgent(testAgent1);
      expect(result.changes).toBe(2);
      
      expect(getMcpSession(testSessionId1)).toBeUndefined();
      expect(getMcpSession(testSessionId2)).toBeUndefined();
      expect(getMcpSession(testSessionId3)).toBeTruthy(); // Agent2's session should remain
    });
  });

  describe('deleteStaleMcpSessions', () => {
    it('should delete sessions older than TTL', async () => {
      upsertMcpSession(testSessionId1, testAgent1);
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 150));
      
      upsertMcpSession(testSessionId2, testAgent1); // Fresh session
      
      // Delete sessions older than 100ms
      const result = deleteStaleMcpSessions(100);
      
      expect(getMcpSession(testSessionId1)).toBeUndefined(); // Should be deleted
      expect(getMcpSession(testSessionId2)).toBeTruthy(); // Should remain
    });
  });

  describe('getMcpSessionCounts', () => {
    it('should return counts grouped by agent', () => {
      upsertMcpSession(testSessionId1, testAgent1);
      upsertMcpSession(testSessionId2, testAgent1);
      upsertMcpSession(testSessionId3, testAgent2);

      const counts = getMcpSessionCounts();
      
      const agent1Count = counts.find(c => c.agent_id === testAgent1);
      const agent2Count = counts.find(c => c.agent_id === testAgent2);
      
      expect(agent1Count?.count).toBeGreaterThanOrEqual(2);
      expect(agent2Count?.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getMcpSessionCount', () => {
    it('should return total session count', () => {
      const initialCount = getMcpSessionCount();
      
      upsertMcpSession(testSessionId1, testAgent1);
      upsertMcpSession(testSessionId2, testAgent2);
      
      const newCount = getMcpSessionCount();
      expect(newCount).toBe(initialCount + 2);
    });
  });
});

describe('MCP Lazy Session Recreation', () => {
  // These tests would require mocking the transport layer
  // For now, we test the DB layer which enables lazy recreation
  
  it('session should be retrievable from DB for recreation', () => {
    const sessionId = 'lazy-test-' + Date.now();
    const agentName = 'LazyTestAgent';
    
    upsertMcpSession(sessionId, agentName);
    
    const session = getMcpSession(sessionId);
    expect(session).toBeTruthy();
    expect(session.agent_id).toBe(agentName);
    
    // Clean up
    deleteMcpSession(sessionId);
  });
});
