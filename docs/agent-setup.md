# Agent Setup

Configure your AI agent to use agentgate.

## Basic Configuration

Add to your agent's system prompt or TOOLS.md:

```
You have access to agentgate at https://your-server.com
API key: rms_your_key_here

For reads: GET /api/{service}/{account}/path
For writes: POST to /api/queue/{service}/{account}/submit with {requests, comment}

Always include a clear comment explaining your intent for write operations.
```

## URL Pattern

All service endpoints follow: `/api/{service}/{accountName}/...`

Examples:
- `GET /api/github/personal/repos/owner/repo`
- `GET /api/bluesky/main/xrpc/app.bsky.feed.getTimeline`
- `GET /api/calendar/work/calendars/primary/events`

## Write Requests

Writes go through the queue for human approval:

```bash
POST /api/queue/github/personal/submit
Authorization: Bearer rms_your_key

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

## Generate a Skill File

For [AgentSkill](https://docs.openclaw.ai/tools/skills) compatible agents:

```bash
curl -H "Authorization: Bearer rms_your_key" \
  https://your-server.com/api/skill > SKILL.md
```

## Using MCP Instead of REST

If your agent supports MCP (Model Context Protocol), you can use that instead of REST. See [MCP setup](mcp.md).

## Agent Registry

Manage agents in the admin UI at `/ui/keys`. Each agent has:

- **Name** - Unique identifier
- **API Key** - Bearer token (shown once at creation)
- **Avatar** - Optional image for UI
- **Webhook URL** - For notifications
- **Auth Bypass** - Skip write queue for trusted agents
