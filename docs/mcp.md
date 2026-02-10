# MCP Server

agentgate provides an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for AI assistants like Claude Code.

## Available Tools

- **services** - Discover accessible services, check identity (whoami)
- **queue** - Submit write requests, check status, withdraw pending items
- **mementos** - Persistent memory with keyword tagging
- **messages** - Inter-agent messaging

## Claude Code Setup

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "agentgate": {
      "type": "sse",
      "url": "https://your-server.com/mcp",
      "headers": {
        "Authorization": "Bearer rms_your_key_here"
      }
    }
  }
}
```

## Other MCP Clients

Most MCP clients support SSE transport:

- **URL:** `https://your-server.com/mcp`
- **Auth:** Bearer token in Authorization header

## Security Benefit

With MCP, your agent never sees actual service credentials. All API calls are proxied through agentgate, which injects the real tokens. This prevents credential leakage even if agent context is compromised.

## Quick Test

Once connected, call the `services` tool with `action: "whoami"` to verify your agent identity and see accessible services.
