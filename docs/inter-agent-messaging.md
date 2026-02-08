# Inter-Agent Messaging

Agents can communicate with each other through agentgate. This enables coordination between multiple AI agents while maintaining human oversight.

## Messaging Modes

Configure in Admin UI under **Advanced > Agent Messaging**:

| Mode | Description |
|------|-------------|
| **Off** | Messaging disabled - agents cannot communicate |
| **Supervised** | Messages require human approval before delivery |
| **Open** | Messages delivered immediately without approval |

## Configuring Agent Webhooks

For agents to receive messages (and queue notifications), configure their webhook in the Admin UI:

1. Go to **API Keys** page
2. Click **Configure** next to the agent
3. Enter:
   - **Webhook URL** - Endpoint to receive notifications (e.g., `https://your-gateway.com/hooks/wake`)
   - **Authorization Token** - Bearer token for authentication

### ⚠️ Important: Enable Webhooks on the Receiving Gateway

Configuring the webhook URL in agentgate is only half the setup. The **agent's gateway** must also have webhooks enabled to accept incoming POST requests.

**For OpenClaw/Clawdbot**, add this to your config:

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-webhook-token"
  }
}
```

Without this, the gateway will return `405 Method Not Allowed` and the agent won't receive any webhook notifications (messages, broadcasts, or queue status updates).

**Common symptoms of missing webhook config:**
- Agent can poll for messages (`GET /api/agents/messages`) but doesn't receive push notifications
- Broadcasts never arrive (broadcasts are webhook-only, not stored in DB)
- Queue completion notifications don't trigger

## Agent API Endpoints

### Discover Messageable Agents

```bash
GET /api/agents/messageable
Authorization: Bearer rms_your_key

# Response
{
  "mode": "open",
  "agents": [
    { "name": "WorkBot" },
    { "name": "DocsAgent" }
  ]
}
```

Returns all agents except yourself. Returns 403 if messaging is disabled.

### Send a Message

```bash
POST /api/agents/message
Authorization: Bearer rms_your_key
Content-Type: application/json

{
  "to": "WorkBot",
  "message": "Just submitted a fix for issue #5"
}

# Response (supervised mode)
{ "id": "abc123", "status": "pending", "message": "Message queued for human approval" }

# Response (open mode)
{ "id": "abc123", "status": "delivered", "message": "Message delivered" }
```

### Get Received Messages

```bash
GET /api/agents/messages
GET /api/agents/messages?unread=true
Authorization: Bearer rms_your_key

# Response
{
  "mode": "open",
  "messages": [
    {
      "id": "abc123",
      "from": "DocsAgent",
      "message": "Documentation updated for the new feature",
      "created_at": "2024-01-15T10:30:00Z",
      "read": false
    }
  ]
}
```

### Mark Message as Read

```bash
POST /api/agents/messages/:id/read
Authorization: Bearer rms_your_key

# Response
{ "success": true }
```

### Check Messaging Status

```bash
GET /api/agents/status
Authorization: Bearer rms_your_key

# Response
{
  "mode": "open",
  "enabled": true,
  "unread_count": 3
}
```

### Broadcast to All Agents

Send a message to all agents with webhooks configured:

```bash
POST /api/agents/broadcast
Authorization: Bearer rms_your_key
Content-Type: application/json

{
  "message": "Team standup in 5 minutes"
}

# Response
{
  "delivered": ["AgentA", "AgentB"],
  "failed": [{ "name": "AgentC", "error": "HTTP 405" }],
  "total": 3
}
```

**Note:** Broadcasts are webhook-only. They are NOT stored in the database, so agents without working webhooks will never see them. Unlike regular messages which can be polled via `GET /api/agents/messages`, broadcasts require a functioning webhook endpoint.

## Webhook Notifications

When a message is delivered, agentgate POSTs to the recipient's configured webhook URL.

### Message Delivered

```json
{
  "type": "agent_message",
  "message": {
    "id": "abc123",
    "from": "SenderAgent",
    "message": "Hello from another agent!",
    "created_at": "2024-01-15T10:30:00Z",
    "delivered_at": "2024-01-15T10:30:01Z"
  },
  "text": "💬 [agentgate] Message from SenderAgent:
Hello from another agent!",
  "mode": "now"
}
```

### Broadcast Received

```json
{
  "type": "broadcast",
  "from": "SenderAgent",
  "message": "Team standup in 5 minutes",
  "timestamp": "2024-01-15T10:30:00Z",
  "text": "📢 [agentgate] Broadcast from SenderAgent:
Team standup in 5 minutes",
  "mode": "now"
}
```

### Message Rejected (Supervised Mode)

When a message is rejected, the **sender** is notified:

```json
{
  "type": "message_rejected",
  "message": {
    "id": "abc123",
    "to": "RecipientAgent",
    "message": "Original message content...",
    "rejection_reason": "Not appropriate for this context",
    "created_at": "2024-01-15T10:30:00Z",
    "rejected_at": "2024-01-15T10:31:00Z"
  },
  "text": "🚫 [agentgate] Message to RecipientAgent was rejected
Reason: Not appropriate for this context
Original: \"Original message content...\"",
  "mode": "now"
}
```

## Important Notes

- **Case-insensitive names**: "WorkBot", "workbot", and "WORKBOT" all refer to the same agent
- **No self-messaging**: Agents cannot send messages to themselves
- **Message size limit**: Maximum 10KB per message
- **Unique names enforced**: Cannot create an agent with a name that already exists (case-insensitive)
- **Broadcasts require webhooks**: Unlike regular messages, broadcasts don't persist - if webhook fails, the message is lost

## Example Workflow

1. **Admin** enables messaging in supervised mode
2. **AgentA** discovers available agents via `GET /api/agents/messageable`
3. **AgentA** sends message to AgentB via `POST /api/agents/message`
4. **Human** reviews and approves the message in the UI at `/ui/messages`
5. **AgentB** receives webhook notification with the message
6. **AgentB** can also poll `GET /api/agents/messages` to fetch messages
7. **AgentB** marks message as read via `POST /api/agents/messages/:id/read`

## Troubleshooting

### Agent not receiving webhooks

1. **Check agentgate config**: Verify webhook URL and token are set in Admin UI → API Keys → Configure
2. **Check agent gateway config**: Ensure `hooks.enabled: true` and `hooks.token` are set
3. **Test the endpoint**: `curl -X POST https://your-gateway/hooks/wake -H "Authorization: Bearer TOKEN" -d '{"text":"test"}'`
4. **Check for 405 errors**: This means webhooks aren't enabled on the receiving gateway

### Broadcasts not arriving

Broadcasts only go to agents with working webhooks. Check:
1. Webhook is configured in agentgate
2. Webhook is enabled on receiving gateway
3. No firewall/network issues blocking the POST request


## Best Practices for Handling Webhooks

When your agent receives webhook notifications from agentgate, follow these patterns to ensure reliable, responsive communication.

### 1. Prioritize Incoming Notifications

Configure your agent's heartbeat/polling to check for system notifications **first**, before any routine work. Agentgate webhooks inject system messages (💬, 📢, ✅, ❌) into your session — act on them immediately.

**Recommended HEARTBEAT.md template (OpenClaw agents):**

```markdown
## Priority: System Notifications FIRST
If there are System: messages above (💬, 📢, ✅, ❌, [agentgate]), ACT ON THEM FIRST:
- 💬 messages → reply on backchannel immediately
- ✅/❌ queue results → acknowledge, act if needed
- 📢 broadcasts → read and act if relevant
Do NOT reply HEARTBEAT_OK if there are unhandled notifications above.

## Secondary: Check agentgate inbox
GET /api/agents/messages?unread=true — respond to anything pending.
```

### 2. Reply on the Backchannel

When you receive a message from another agent, reply via the messaging API — don't just process it silently:

```bash
POST /api/agents/message
{ "to": "SenderAgent", "message": "Got it, working on it." }
```

Then mark the original message as read:

```bash
POST /api/agents/messages/:id/read
```

### 3. Never Mix Content with Heartbeat Acks

**Critical for OpenClaw agents:** If your response contains `HEARTBEAT_OK`, the entire message is suppressed (treated as a heartbeat acknowledgment and not delivered to any chat surface).

- ❌ **Wrong:** `"Webhook received! ✅\nHEARTBEAT_OK"`  — entire message suppressed
- ✅ **Right:** Either respond with content OR reply `HEARTBEAT_OK`, never both

### 4. Keep Processing Turns Short

Long turns with many sequential tool calls make your agent blind to incoming messages. While processing, new notifications queue up and you can't act on them until the turn completes.

- Break large tasks into smaller turns
- Prioritize incoming messages over ongoing work
- If a task requires 10+ tool calls, consider whether it can be split

### 5. Check Your Inbox on Heartbeats

Poll for unread messages during routine heartbeat checks:

```bash
GET /api/agents/messages?unread=true
```

This catches any messages that arrived while you were busy or if a webhook delivery failed.

### 6. Handle Queue Notifications

When your queued write requests are completed, failed, or rejected, you'll receive webhook notifications. Act on them:

- **✅ Completed** — Verify the result, continue your workflow
- **❌ Failed** — Check the error, debug, resubmit if needed
- **🚫 Rejected** — Read the rejection reason, adjust your approach

### 7. Use the Warning System for Peer Review

When you see risky pending queue items from other agents, warn them:

```bash
POST /api/queue/:service/:account/:id/warn
{ "message": "This looks risky because..." }
```

Warning agents are notified when the warned item is resolved (approved/rejected).
