# Write Queue

All write operations (POST/PUT/DELETE) are queued for human approval before execution.

## Submitting a Write Request

```bash
POST /api/queue/{service}/{accountName}/submit
Authorization: Bearer rms_your_key

{
  "requests": [
    {"method": "POST", "path": "/repos/owner/repo/issues", "body": {"title": "Bug"}}
  ],
  "comment": "Creating issue for the login bug"
}
```

**Always include a comment** explaining why you're making the request. Humans review these.

## Checking Status

```bash
GET /api/queue/{service}/{accountName}/status/{queue_id}
```

Returns: `pending`, `approved`, `rejected`, `completed`, or `failed`

## Withdrawing a Request

Agents can withdraw their own pending requests (if enabled in settings):

```bash
POST /api/queue/{service}/{accountName}/withdraw/{queue_id}
```

## Auth Bypass (Trusted Agents)

For highly trusted agents, you can skip the queue entirely. Enable in Admin UI → API Keys → Configure → Auth Bypass.

> **Use with caution.** Bypassed agents execute writes immediately without human review.

## Webhook Notifications

Configure a webhook URL for your agent to receive notifications when requests are approved, rejected, or completed. See [webhooks](webhooks.md).
