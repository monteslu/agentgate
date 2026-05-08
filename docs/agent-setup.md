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

## Hermes

Hermes can use agentgate two ways. They compose — same API key, different surfaces.

### Option A: MCP (general agentgate access)

Hermes has built-in MCP client support. Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  agentgate:
    transport: http        # or sse
    url: https://your-server.com/mcp
    headers:
      Authorization: "Bearer rms_your_key_here"
```

The `services`, `queue`, `mementos`, and `messages` tools auto-appear in Hermes. The agent never sees real service credentials. Hot-reloads on server changes via `tools/list_changed`.

### Option B: hermes-agentgate channel plugin (real-time chat + system events)

For real-time chat between humans and your Hermes agent through the agentgate `/channel/` UI, plus push delivery of queue notifications and broadcasts, install the native Python plugin:

```bash
pip install hermes-agentgate
```

Configure via env or `~/.hermes/config.yaml`:

```bash
export AGENT_GATE_URL="https://your-server.com"
export AGENT_GATE_TOKEN="rms_your_key_here"
```

Restart Hermes. AgentGate appears as a messaging platform alongside Telegram/Discord/Slack/Signal. See [hermes-agentgate](https://github.com/monteslu/hermes-agentgate) for the full setup and protocol details.

The two layers compose: MCP gives the agent structured tools (deterministic, schema-validated, lower-hallucination than skill files). The channel plugin gives it real-time human chat and push-delivery of queue events.

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
