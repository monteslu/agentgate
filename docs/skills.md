# Skills

agentgate works great with [OpenClaw](https://openclaw.ai) and [ClawdBot](https://clawdbot.com) - agents that use skills to interact with the world.

Skills teach agents how to use tools. Each skill is a `SKILL.md` file with YAML frontmatter and instructions. agentgate generates a complete skill file tailored to your agent's access.

## Generate a Skill File

```bash
curl -H "Authorization: Bearer rms_your_key" \
  https://your-server.com/api/skill > SKILL.md
```

Drop this in your agent's skills folder:
- **OpenClaw**: `~/.openclaw/skills/agentgate/SKILL.md` (shared) or `<workspace>/skills/agentgate/SKILL.md` (per-agent)
- **ClawdBot**: Your configured skills directory

The generated skill includes:
- All services your agent can access
- Endpoint patterns and examples
- Write queue instructions
- Messaging and memento APIs

## What's in the Skill File

```markdown
---
name: agentgate
description: API gateway for personal data with human-in-the-loop write approval
---

## Authentication
Bearer token: Use Authorization header with your API key

## Services
- GitHub: /api/github/{account}/...
- Bluesky: /api/bluesky/{account}/...
...

## Write Queue
POST /api/queue/{service}/{account}/submit
{ "requests": [...], "comment": "why" }

## Agent Messaging
POST /api/agents/message
{ "to_agent": "OtherBot", "message": "..." }

## Mementos
POST /api/agents/memento
{ "content": "...", "keywords": ["..."] }
```

## Dynamic Documentation

Agents can also fetch live API docs at runtime:

```bash
GET /api/readme
Authorization: Bearer rms_your_key
```

Returns full documentation for all endpoints. Useful for agents that build tools dynamically or need to discover available services.

## Multi-Agent Setup

Each agent gets their own API key, so each agent's skill file reflects only what they can access. A "SocialBot" might only see Bluesky and Mastodon, while "DevBot" sees GitHub and Jira.

Generate separate skill files for each agent:

```bash
curl -H "Authorization: Bearer rms_socialbot_key" .../api/skill > socialbot-agentgate.md
curl -H "Authorization: Bearer rms_devbot_key" .../api/skill > devbot-agentgate.md
```

## Webhook Notifications

Configure a webhook URL for your agent to get notified when write requests are approved or rejected. Works with OpenClaw's `/hooks/wake` endpoint.

See [webhooks](webhooks.md) for setup.
