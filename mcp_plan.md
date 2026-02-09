# MCP Implementation Plan

## Status: IMPLEMENTED

The MCP server is fully implemented and working. This document now serves as reference documentation.

## What Was Built

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Transport Layer                                │
├─────────────────┬───────────────────────────────┤
│  HTTP Routes    │  MCP Server (SSE)             │
│  /api/queue     │  GET /mcp (SSE connection)    │
│  /api/agents    │  POST /mcp (messages)         │
│  etc.           │                               │
└────────┬────────┴────────┬──────────────────────┘
         │                 │
         └────────┬────────┘
                  ↓
         ┌────────────────┐
         │ Service Layer  │
         ├────────────────┤
         │ queueService   │
         │ messageService │
         │ mementoService │
         │ serviceService │
         └────────────────┘
                  ↓
         ┌────────────────┐
         │  db.js         │
         └────────────────┘
```

### Files Created

1. **src/services/queueService.js** - Queue operations (submit, list, status, withdraw, warn, get_warnings)
2. **src/services/messageService.js** - Placeholder for messaging operations
3. **src/services/mementoService.js** - Memento operations (save, search, keywords, recent, get_by_ids)
4. **src/services/serviceService.js** - Service access operations (list, get_access, check_bypass)
5. **src/routes/mcp.js** - MCP server with SSE transport

### Files Modified

1. **src/index.js** - Added MCP routes:
   ```javascript
   import { createMCPSSEHandler, createMCPMessageHandler } from './routes/mcp.js';

   app.get('/mcp', apiKeyAuth, createMCPSSEHandler());
   app.post('/mcp', apiKeyAuth, createMCPMessageHandler());
   ```

2. **src/routes/queue.js** - Refactored to use service layer

## MCP Server Details

### SDK Version & API

Uses `@modelcontextprotocol/sdk` with the **new API**:
- `McpServer` class (not the deprecated `Server` class)
- `registerTool()` method with Zod schemas
- `SSEServerTransport` for SSE connections

```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const server = new McpServer({ name: 'agentgate', version: '1.0.0' }, {
  capabilities: { tools: {}, resources: {} }
});

server.registerTool('toolname', {
  description: '...',
  inputSchema: z.object({ ... })
}, async (args) => { ... });
```

### Session Management

Sessions are stored in a Map keyed by sessionId:
```javascript
const activeSessions = new Map(); // sessionId -> { transport, server, agentName }
```

**Important fix**: The `transport.onclose` handler should NOT call `server.close()` as this causes infinite recursion (stack overflow). Just delete from activeSessions:
```javascript
transport.onclose = () => {
  activeSessions.delete(sessionId);
};
```

### 4 Consolidated Tools (Action-Based)

Rather than many top-level tools, we consolidated into 4 tools with action parameters for better LLM compatibility:

1. **queue** - Actions: submit, list, status, withdraw, warn, get_warnings
2. **messages** - Actions: send, get, mark_read, list_agents, status, broadcast, list_broadcasts, get_broadcast
3. **mementos** - Actions: save, search, keywords, recent, get_by_ids
4. **services** - Actions: whoami, list, get_access, check_bypass

All tool descriptions mention "AgentGate" for context.

## Claude Code Configuration

MCP server configured in `~/.claude.json`:

```json
{
  "projects": {
    "/home/monteslu/code/mine/readmystuff": {
      "mcpServers": {
        "agentgate": {
          "type": "sse",
          "url": "http://localhost:3050/mcp",
          "headers": {
            "Authorization": "Bearer YOUR_API_KEY_HERE"
          }
        }
      }
    }
  }
}
```

## Testing

### Verify Server Running
```bash
curl -s http://localhost:3050/health
# {"status":"ok","timestamp":...}
```

### Test MCP SSE Connection
```bash
curl -N -H "Authorization: Bearer YOUR_API_KEY" "http://localhost:3050/mcp"
# event: endpoint
# data: /mcp?sessionId=...
```

### Test via REST API (same underlying services)
```bash
# Submit a Bluesky post to approval queue
curl -X POST -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "requests": [{
      "method": "POST",
      "path": "/xrpc/com.atproto.repo.createRecord",
      "body": {
        "repo": "yourhandle.bsky.social",
        "collection": "app.bsky.feed.post",
        "record": {
          "$type": "app.bsky.feed.post",
          "text": "Hello from AgentGate!",
          "createdAt": "2026-02-09T22:00:00.000Z"
        }
      }
    }],
    "comment": "Test post"
  }' \
  "http://localhost:3050/api/queue/bluesky/accountname/submit"
```

### Check Queue Status
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "http://localhost:3050/api/queue/bluesky/accountname/status/QUEUE_ID"
```

## To Test MCP Tools Directly

Since MCP tools are added at session start, you need to **start a new Claude Code session** for the tools to be available. The tools won't appear mid-conversation.

Once in a new session, you can use:
- `mcp__agentgate__queue`
- `mcp__agentgate__messages`
- `mcp__agentgate__mementos`
- `mcp__agentgate__services`

## Known Issues Fixed

1. **"Schema is missing a method literal" error** - SDK changed API from `Server.setRequestHandler('tools/list', ...)` to `McpServer.registerTool()` with Zod schemas

2. **Stack overflow on connection close** - Don't call `server.close()` in `transport.onclose` handler

## Future Enhancements

- [ ] Add MCP Resources (e.g., `agentgate://readme`)
- [ ] Prompt templates for common operations
- [ ] WebSocket transport support (if needed)
- [ ] Unit tests for service layer
- [ ] Integration tests for MCP endpoint
