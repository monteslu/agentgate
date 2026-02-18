# Channel WebSocket Protocol Specification

## Overview

The channel WebSocket protocol multiplexes three distinct message types over a single persistent WebSocket connection between AgentGate and the `agentgate-channel` OpenClaw plugin, enabling remote agents to chat, inject system events, and trigger agent turns — all without inbound networking.

## Architecture

```
Remote Agent ──AgentGate API──→ AgentGate Server
                                     ↓
                              /channel/ WebSocket
                                     ↓
                           agentgate-channel plugin (inside OpenClaw)
                                     ↓
                    ┌────────────────┼────────────────┐
                    ↓                ↓                ↓
            dispatchInbound    POST /hooks/wake   POST /hooks/agent
            (chat reply ←WS)   (system event)    (isolated agent turn)
```

**Key insight:** The plugin runs inside OpenClaw and connects *outbound* to AgentGate. It can call OpenClaw's local hooks on `127.0.0.1` without any LAN/firewall/port configuration.

## Connection

- Plugin connects to `ws[s]://{agentgate-host}/api/channel/{channel-id}`
- Auth: `Authorization: Bearer {agent-api-key}` header on upgrade request
- Server sends `connected` envelope on successful auth
- Reconnect with exponential backoff on disconnect
- Keepalive pings every 30s

## Envelope Format

All messages are JSON with a required `type` field:

```json
{
  "type": "message" | "wake" | "agent" | "reply" | "chunk" | "done" | "ack" | "error" | "ping" | "pong" | "connected",
  ...
}
```

## Server → Plugin (Inbound)

### `connected` — Connection Established

Sent by AgentGate after successful auth.

```json
{
  "type": "connected",
  "channelId": "ch_abc",
  "humans": ["human_a1b2c3d4"]
}
```

### `message` — Chat (expects reply)

Human or agent wants a conversational response.

```json
{
  "type": "message",
  "id": "msg_abc123",
  "from": "human",
  "text": "What's the weather like?",
  "timestamp": "2026-02-15T01:45:00Z",
  "connId": "human_a1b2c3d4"
}
```

**Plugin action:** `dispatchInboundMessage()` → reply sent back as `reply` envelope.

### `wake` — System Event (fire and forget)

Inject a system event into the main session. No reply expected.

```json
{
  "type": "wake",
  "id": "wake_def456",
  "text": "Queue #42 has been approved",
  "mode": "now",
  "connId": "human_a1b2c3d4"
}
```

- `mode`: `"now"` (wake immediately) or `"next-heartbeat"` (inject on next heartbeat). Default: `"now"`.

**Plugin action:** HTTP POST to `http://127.0.0.1:{gateway.port}/hooks/wake` with `{ text, mode }`.

### `agent` — Isolated Agent Turn (fire and forget)

Trigger a full agent processing cycle in an isolated session.

```json
{
  "type": "agent",
  "id": "agent_ghi789",
  "message": "Check if PR #42 CI passed",
  "connId": "human_a1b2c3d4",
  "name": "pr-check",
  "deliver": true,
  "channel": "last",
  "model": "anthropic/claude-sonnet-4-20250514",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

**Plugin action:** HTTP POST to `http://127.0.0.1:{gateway.port}/hooks/agent` with the payload.

### `human_connected` / `human_disconnected`

Notifies the plugin when human clients connect or disconnect.

```json
{ "type": "human_connected", "connId": "human_a1b2c3d4" }
{ "type": "human_disconnected", "connId": "human_a1b2c3d4" }
```

## Plugin → Server (Outbound)

### `reply` — Chat Response

Response to a `message`. Maps to existing `message` type in the agent protocol.

```json
{
  "type": "message",
  "id": "reply_jkl012",
  "replyTo": "msg_abc123",
  "text": "It's 72°F and sunny.",
  "connId": "human_a1b2c3d4"
}
```

### `chunk` — Streaming Response

Partial response for streaming/typing indicators.

```json
{
  "type": "chunk",
  "id": "reply_jkl012",
  "text": "It's 72°F",
  "connId": "human_a1b2c3d4"
}
```

### `done` — Stream Complete

Signals end of streaming for a reply.

```json
{
  "type": "done",
  "id": "reply_jkl012",
  "text": "Full final text (optional)",
  "connId": "human_a1b2c3d4"
}
```

### `ack` — Acknowledgment

Confirms receipt of `wake` or `agent` messages.

```json
{
  "type": "ack",
  "id": "wake_def456",
  "status": "dispatched",
  "connId": "human_a1b2c3d4"
}
```

### `error` — Error

Something went wrong processing a message.

```json
{
  "type": "error",
  "error": "Hooks not enabled in OpenClaw config",
  "messageId": "msg_abc123",
  "connId": "human_a1b2c3d4"
}
```

### `ping` / `pong` — Keepalive

```json
{ "type": "ping" }
{ "type": "pong" }
```

Both server and plugin send `ping` and respond with `pong`.

## Delivery Priority

When AgentGate needs to deliver a message to an OpenClaw instance:

1. **WebSocket** — if the agent is connected via channel plugin, deliver instantly over WS
2. **Webhook** — if no WS connection, fall back to configured webhook URL
3. **Queue** — if neither available, hold for next connection (up to 100 messages)

## Plugin Configuration

```json
{
  "agentgate": {
    "url": "https://your-agentgate.example.com",
    "token": "agent-api-key",
    "reconnectIntervalMs": 5000,
    "maxReconnectIntervalMs": 60000,
    "pingIntervalMs": 30000
  }
}
```

## Security

- Agent authenticates to AgentGate with its API key (existing Bearer auth on upgrade)
- Local hooks calls use `127.0.0.1` — never leave the machine
- Hooks token read from OpenClaw config at runtime
- No inbound ports required on the OpenClaw machine
- AgentGate's existing access control governs which agents can send messages
- Each API key is scoped to a specific channel (`channel_id` + `channel_enabled`)

## Extracting Hook Config

The plugin reads from `ChannelGatewayContext`:

```javascript
const gatewayPort = ctx.cfg.gateway?.port ?? 18789;
const hooksToken = ctx.cfg.hooks?.token;
const hooksPath = ctx.cfg.hooks?.path ?? '/hooks';
const hooksEnabled = ctx.cfg.hooks?.enabled ?? false;

const wakeUrl = `http://127.0.0.1:${gatewayPort}${hooksPath}/wake`;
const agentUrl = `http://127.0.0.1:${gatewayPort}${hooksPath}/agent`;
```

If hooks are not enabled, the plugin logs a warning and only supports `message` type (chat). `wake` and `agent` types return an `error` envelope.
