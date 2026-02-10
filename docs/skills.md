# Skills

agentgate works great with [OpenClaw](https://openclaw.ai) and [ClawdBot](https://clawdbot.com) - agents that use skills to interact with the world.

Skills teach agents how to use tools. Each skill is a `SKILL.md` file with YAML frontmatter and instructions. agentgate generates category-based skills so agents only load what's relevant to the task at hand.

## OpenClaw Setup

1. In agentgate Admin UI (`/ui`), create an API key for your agent
2. Add environment variables to your OpenClaw agent config:
   - `AGENT_GATE_URL` — your agentgate URL (e.g., `https://your-server.com`)
   - `AGENT_GATE_TOKEN` — the API key from step 1
3. Tell the agent: **"Install agentgate skills by running: `curl -s $AGENT_GATE_URL/api/skill/setup | node`"**
4. Start a new conversation — OpenClaw loads skills per-session, so the agent needs a fresh session to pick them up

The setup script writes skill files to `~/.openclaw/skills/` where OpenClaw's file watcher detects them automatically. Re-run the command anytime to update skills after adding new services.

## Generated Skills

The setup script creates multiple focused skills instead of one monolithic file:

| Skill | Always generated | Content |
|---|---|---|
| `agentgate` | Yes | Auth, service discovery, queue management, bypass info |
| `agentgate-messages` | Yes | Agent-to-agent messaging and broadcasts |
| `agentgate-mementos` | Yes | Persistent memory with keyword search |
| `agentgate-search` | If search services configured | Brave Search, Google Search |
| `agentgate-social` | If social services configured | Bluesky, Mastodon, Reddit, LinkedIn |
| `agentgate-code` | If code services configured | GitHub, Jira |
| `agentgate-personal` | If personal services configured | Fitbit, Calendar, YouTube |

OpenClaw reads one skill at a time based on the task, so category skills keep token usage efficient — a search task only loads the search skill, not all of agentgate.

## Manual Setup

If you prefer to manage skill files yourself:

```bash
# Fetch all skills as JSON
curl -H "Authorization: Bearer $AGENT_GATE_TOKEN" \
  $AGENT_GATE_URL/api/skill | jq .
```

The `/api/skill` endpoint returns `{ skills: { "agentgate": "...", "agentgate-search": "...", ... } }`. Write each value to `~/.openclaw/skills/{name}/SKILL.md`.

## Dynamic Documentation

Agents can also fetch live API docs at runtime:

```bash
GET /api/agent_start_here
Authorization: Bearer $AGENT_GATE_TOKEN
```

Returns full endpoint documentation filtered to the agent's accessible services.

## Webhook Notifications

Configure a webhook URL for your agent to get notified when write requests are approved or rejected. Works with OpenClaw's `/hooks/wake` endpoint.

See [webhooks](webhooks.md) for setup.
