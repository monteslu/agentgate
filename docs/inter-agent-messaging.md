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
   - **Webhook URL** - Endpoint to receive notifications (e.g., `https://your-gateway.com/hooks/agentgate`)
   - **Authorization Token** - Bearer token for authentication

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
  "text": "💬 [agentgate] Message from SenderAgent:\nHello from another agent!",
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
  "text": "🚫 [agentgate] Message to RecipientAgent was rejected\nReason: Not appropriate for this context\nOriginal: \"Original message content...\"",
  "mode": "now"
}
```

## Important Notes

- **Case-insensitive names**: "WorkBot", "workbot", and "WORKBOT" all refer to the same agent
- **No self-messaging**: Agents cannot send messages to themselves
- **Message size limit**: Maximum 10KB per message
- **Unique names enforced**: Cannot create an agent with a name that already exists (case-insensitive)

## Example Workflow

1. **Admin** enables messaging in supervised mode
2. **AgentA** discovers available agents via `GET /api/agents/messageable`
3. **AgentA** sends message to AgentB via `POST /api/agents/message`
4. **Human** reviews and approves the message in the UI at `/ui/messages`
5. **AgentB** receives webhook notification with the message
6. **AgentB** can also poll `GET /api/agents/messages` to fetch messages
7. **AgentB** marks message as read via `POST /api/agents/messages/:id/read`
