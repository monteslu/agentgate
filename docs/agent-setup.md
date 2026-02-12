# Agent Setup

Configure your AI agent to use agentgate.

## Prerequisites

1. agentgate is running and accessible (locally or via tunnel)
2. You've created an API key for the agent in Admin UI (`/ui` → API Keys)

## OpenClaw / ClawdBot

### 1. Install skills from ClawHub

```bash
clawhub install agentgate
```

This installs the agentgate skill pack into your workspace. Start a new session to pick up the skills.

### 2. Configure environment variables

Add these to your agent's config (via `skills.entries` in `openclaw.json`):

```json5
{
  skills: {
    entries: {
      "agentgate": {
        enabled: true,
        apiKey: "your-agent-gate-token",
        env: {
          AGENT_GATE_URL: "https://your-server.com"
        }
      }
    }
  }
}
```

- `apiKey` maps to `AGENT_GATE_TOKEN` (the skill's `primaryEnv`)
- `AGENT_GATE_URL` is your agentgate server URL

### 3. Start a new conversation

Skills are loaded per-session. Start a fresh conversation and the agent will have full agentgate access.

### Updating skills

```bash
clawhub update agentgate
```

Or update all installed skills:

```bash
clawhub update --all
```

### Dynamic service discovery

The installed skills include your agent's available services. For the latest service list at runtime:

```
GET $AGENT_GATE_URL/api/agent_start_here
Authorization: Bearer $AGENT_GATE_TOKEN
```

## Claude Code (MCP)

Claude Code connects to agentgate via MCP. Add the server:

```bash
claude mcp add --transport http agentgate https://your-server.com/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

The agent gets tools for services, queue, messaging, and mementos automatically. See [MCP setup](mcp.md) for details.

## Other Agents (REST)

Any agent that can make HTTP requests can use agentgate's REST API.

### Authentication

All requests need the API key in the Authorization header:

```
Authorization: Bearer YOUR_API_KEY
```

### URL pattern

Service endpoints follow: `/api/{service}/{accountName}/...`

Examples:
- `GET /api/github/personal/repos/owner/repo`
- `GET /api/bluesky/main/xrpc/app.bsky.feed.getTimeline`
- `GET /api/calendar/work/calendars/primary/events`

### Write requests

Writes go through the queue for human approval:

```bash
POST /api/queue/github/personal/submit
Authorization: Bearer YOUR_API_KEY

{
  "requests": [
    {"method": "POST", "path": "/repos/owner/repo/issues", "body": {"title": "Bug fix"}}
  ],
  "comment": "Creating issue for the auth bug we discussed"
}
```

Check status:
```bash
GET /api/queue/github/personal/status/{queue_id}
```

### API documentation

Point the agent at the live docs endpoint for full API reference:

```bash
GET /api/agent_start_here
Authorization: Bearer YOUR_API_KEY
```

## Agent Registry

Manage agents in the admin UI at `/ui` → API Keys. Each agent has:

- **Name** — unique identifier
- **API Key** — bearer token (shown once at creation)
- **Avatar** — optional image for UI
- **Webhook URL** — for notifications ([setup](webhooks.md))
- **Auth Bypass** — skip write queue for trusted agents
