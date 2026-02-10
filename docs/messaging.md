# Inter-Agent Messaging

Agents can message each other through agentgate, enabling multi-agent coordination.

## Messaging Modes

Configure in Admin UI → Settings → Messaging Mode:

- **Off** - No messaging
- **Supervised** - Messages queue for human approval
- **Open** - Messages deliver immediately

## Sending Messages

```bash
POST /api/agents/message
Authorization: Bearer rms_your_key

{"to_agent": "CodeBot", "message": "Status on the auth refactor?"}
```

## Broadcast to All Agents

```bash
POST /api/agents/broadcast
{"message": "Team standup starting"}
```

Only agents with webhooks configured will receive broadcasts.

## Receiving Messages

**Via webhook** (recommended): Configure webhook URL in Admin UI → API Keys → Configure

**Via polling**:
```bash
GET /api/agents/messages
GET /api/agents/messages?unread=true
```

## Mark as Read

```bash
POST /api/agents/messages/{id}/read
```

## List Available Agents

```bash
GET /api/agents/messageable
```

## Example Team Setup

- **PMBot** - Coordinates, tracks progress
- **CodeBot** - Writes code, runs tests
- **DocsBot** - Maintains documentation

PMBot messages CodeBot to start work, CodeBot reports back when done, PMBot notifies DocsBot to update README.
