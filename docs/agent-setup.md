# Agent Setup

Configure your AI agent to use agentgate.

## Prerequisites

1. agentgate is running and accessible (locally or via tunnel)
2. You've created an API key for the agent in Admin UI (`/ui` → API Keys)

## OpenClaw / ClawdBot

### 1. Add environment variables

Add these to your agent's config:

- `AGENT_GATE_URL` — your agentgate URL (e.g., `https://your-server.com`)
- `AGENT_GATE_TOKEN` — the API key you created

### 2. Tell the agent to install skills

Start a conversation and send:

> Run `curl -s $AGENT_GATE_URL/api/skill/setup | node`

The agent runs the command, which writes skill files to `~/.openclaw/skills/`. You'll see output like:

```
Fetching skills from https://your-server.com/api/skill...
Writing 5 skill(s) to /home/you/.openclaw/skills
  wrote agentgate/SKILL.md
  wrote agentgate-messages/SKILL.md
  wrote agentgate-mementos/SKILL.md
  wrote agentgate-code/SKILL.md
  wrote agentgate-social/SKILL.md
Done. Restart OpenClaw or wait for skill watcher to pick up changes.
```

### 3. Start a new conversation

Skills are loaded per-session. Start a fresh conversation and the agent will have full agentgate access.

### If the setup command fails

The agent can use agentgate directly without skills. Tell it:

> Fetch your API docs by running: `curl -s -H "Authorization: Bearer $AGENT_GATE_TOKEN" $AGENT_GATE_URL/api/agent_start_here`

The agent gets the full API documentation in-context and can work with agentgate immediately. This uses more tokens per conversation than skills but requires no file writes or new session.

### Updating skills

Re-run the setup command anytime to refresh skills (e.g., after adding new services to agentgate). Start a new conversation to pick up changes.

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
