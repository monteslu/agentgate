# Webhooks

agentgate can notify agents when events occur.

## Agent Webhooks

Configure per-agent in Admin UI → API Keys → Configure:

- **Webhook URL** - Where to POST notifications
- **Webhook Token** - Bearer token for authentication

### Events

Agents receive webhooks for:
- Queue item approved/rejected/completed/failed
- Inter-agent message delivery

### Payload Format

```json
{
  "text": "✅ [agentgate] Queue #abc123 completed\n→ github/monteslu\nOriginal: \"Create PR for fix\"",
  "mode": "now"
}
```

Compatible with OpenClaw's `/hooks/wake` endpoint.

## GitHub Webhooks

agentgate can receive GitHub webhook events and forward them to agents.

### Setup

1. In GitHub repo settings, add webhook:
   - URL: `https://your-agentgate.com/webhooks/github`
   - Content type: `application/json`
   - Secret: Configure in agentgate settings

2. Configure forwarding in Admin UI → Settings

### Supported Events

- Push
- Pull request (opened, closed, merged, review requested)
- Issues
- Workflow runs

## Notification Status

The Admin UI shows notification status on queue items:
- ✓ Notified
- ⚠ Failed (with retry option)

"Retry All" sends missed notifications in one batched message.
