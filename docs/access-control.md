# Service Access Control

Control which agents can access specific services.

## Access Modes

Each service/account can be set to:

- **All** (default) - All agents can access
- **Allowlist** - Only listed agents can access
- **Denylist** - All agents except listed ones can access

## Setup

Admin UI → Services → Click a service → Configure access mode and agent list

## API

Agents can check their access:

```bash
GET /api/services
Authorization: Bearer rms_your_key
```

Returns only services the agent can access.

## Behavior

When an agent lacks access, API calls return `403 Forbidden`:

```json
{"error": "Access denied to github/personal"}
```

## Auth Bypass

Separate from access control - allows trusted agents to skip the write queue. Configure per-agent in Admin UI → API Keys → Configure → Auth Bypass.

Access control still applies even with auth bypass enabled.
