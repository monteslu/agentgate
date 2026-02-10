import { Router } from 'express';
import { getAccountsByService } from '../lib/db.js';
import SERVICE_REGISTRY, { SERVICE_CATEGORIES } from '../lib/serviceRegistry.js';

const router = Router();

// Generate category-based OpenClaw skills for all configured services
// See: https://docs.openclaw.ai/tools/skills
router.get('/', (req, res) => {
  const baseUrl = req.query.base_url || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3050}`;
  const accountsByService = getAccountsByService();

  // Build flat list of configured service/account pairs
  const configuredServices = [];
  for (const [serviceKey, info] of Object.entries(SERVICE_REGISTRY)) {
    const dbKey = info.dbKey || serviceKey;
    const accounts = accountsByService[dbKey] || [];
    for (const account of accounts) {
      configuredServices.push({ service: serviceKey, account_name: account, info });
    }
  }

  const skills = {};

  // Always generate the base agentgate skill
  skills['agentgate'] = generateBaseSkill(baseUrl, configuredServices);

  // Always generate messaging and mementos skills
  skills['agentgate-messages'] = generateMessagesSkill();
  skills['agentgate-mementos'] = generateMementosSkill();

  // Generate a skill per category that has at least one configured service
  for (const [category, catInfo] of Object.entries(SERVICE_CATEGORIES)) {
    const categoryServices = configuredServices.filter(svc =>
      catInfo.services.includes(svc.service)
    );

    if (categoryServices.length === 0) continue;

    skills[`agentgate-${category}`] = generateCategorySkill(
      baseUrl, category, catInfo, categoryServices
    );
  }

  res.json({ skills });
});

function generateBaseSkill(baseUrl, configuredServices) {
  const serviceList = configuredServices
    .map(svc => `- **${svc.service}**: ${svc.account_name}`)
    .join('\n');

  return `---
name: agentgate
description: API gateway for personal data with human-in-the-loop write approval. Read requests execute immediately. Write requests are queued for approval.
metadata: { "openclaw": { "emoji": "🚪", "requires": { "env": ["AGENT_GATE_TOKEN", "AGENT_GATE_URL"] } } }
---

# agentgate

API gateway for accessing personal data with human-in-the-loop write approval.

## Configuration

- **Base URL**: \`$AGENT_GATE_URL\` (currently: \`${baseUrl}\`)
- **API Key**: Use the \`AGENT_GATE_TOKEN\` environment variable

## Authentication

All requests require the API key in the Authorization header:

\`\`\`
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

## Configured Services

${serviceList || '_No services configured yet_'}

## Service Discovery

For complete endpoint documentation:
\`\`\`
GET $AGENT_GATE_URL/api/agent_start_here
\`\`\`

## Write Queue Management

Write operations go through an approval queue. After submitting a write (via a category skill), manage it here:

**Check status:**
\`\`\`
GET $AGENT_GATE_URL/api/queue/{service}/{accountName}/status/{id}
\`\`\`

Statuses: \`pending\` → \`approved\` → \`executing\` → \`completed\` (or \`rejected\`/\`failed\`/\`withdrawn\`)

**Withdraw a pending request:**
\`\`\`
DELETE $AGENT_GATE_URL/api/queue/{service}/{accountName}/status/{id}
{ "reason": "No longer needed" }
\`\`\`

**Bypass mode:** If your agent has bypass_auth enabled (configured by admin), writes execute immediately — the response will include \`"bypassed": true\` with results inline. No polling needed.

## Binary Uploads

For binary data (images, files), set \`binaryBase64: true\` in the write request:

\`\`\`json
{
  "method": "POST",
  "path": "com.atproto.repo.uploadBlob",
  "binaryBase64": true,
  "headers": { "Content-Type": "image/jpeg" },
  "body": "<base64 encoded data>"
}
\`\`\`

## Important Notes

- Always include a clear comment explaining your intent when writing
- Include markdown links to relevant resources (issues, PRs, docs)
- Be patient with writes — approval requires human action
`;
}

function generateCategorySkill(baseUrl, category, catInfo, categoryServices) {
  const accountList = categoryServices
    .map(svc => `${svc.service}: ${svc.account_name}`)
    .join(', ');

  const serviceListMd = categoryServices
    .map(svc => {
      const docsLine = svc.info?.docs ? ` — [docs](${svc.info.docs})` : '';
      return `- **${svc.service}**: ${svc.account_name}${docsLine}`;
    })
    .join('\n');

  // Collect read examples from registry, replacing {accountName} with real accounts
  const readExamples = [];
  for (const svc of categoryServices) {
    if (svc.info?.examples) {
      for (const example of svc.info.examples) {
        const filled = example.replace('{accountName}', svc.account_name);
        readExamples.push(`\`${filled.replace('GET ', '$AGENT_GATE_URL')}\``);
      }
    }
  }

  // Collect write guidelines
  const writeGuidelines = [];
  const seen = new Set();
  for (const svc of categoryServices) {
    if (svc.info?.writeGuidelines && !seen.has(svc.service)) {
      seen.add(svc.service);
      writeGuidelines.push(`### ${svc.info.name}\n${svc.info.writeGuidelines.map(g => `- ${g}`).join('\n')}`);
    }
  }

  const actions = catInfo.hasWrite ? 'Read and write' : 'Read';
  const description = `${actions} ${catInfo.description} via agentgate. Accounts: ${accountList}.`;

  let body = `---
name: agentgate-${category}
description: "${description}"
metadata: { "openclaw": { "emoji": "🚪", "requires": { "env": ["AGENT_GATE_TOKEN", "AGENT_GATE_URL"] } } }
---

# agentgate — ${catInfo.name}

${catInfo.description}.

## Accounts

${serviceListMd}

## Reading Data

Make GET requests with the Authorization header:

\`\`\`
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

${readExamples.length > 0 ? '### Examples\n\n' + readExamples.map(e => `- ${e}`).join('\n') : ''}
`;

  if (catInfo.hasWrite) {
    body += `
## Writing Data

Write operations (POST/PUT/PATCH/DELETE) go through the approval queue:

\`\`\`
POST $AGENT_GATE_URL/api/queue/{service}/{accountName}/submit
Authorization: Bearer $AGENT_GATE_TOKEN
Content-Type: application/json

{
  "requests": [
    {
      "method": "POST",
      "path": "/the/api/path",
      "body": { "your": "payload" }
    }
  ],
  "comment": "Explain what you are doing and why. Include [links](url) to relevant issues/PRs."
}
\`\`\`

Then poll for status (see agentgate base skill for details):
\`\`\`
GET $AGENT_GATE_URL/api/queue/{service}/{accountName}/status/{id}
\`\`\`
`;

    if (writeGuidelines.length > 0) {
      body += `\n## Write Guidelines\n\n${writeGuidelines.join('\n\n')}\n`;
    }
  }

  return body;
}

function generateMessagesSkill() {
  return `---
name: agentgate-messages
description: "Send and receive messages between AI agents via agentgate. Supports direct messages and broadcasts."
metadata: { "openclaw": { "emoji": "💬", "requires": { "env": ["AGENT_GATE_TOKEN", "AGENT_GATE_URL"] } } }
---

# agentgate — Messages

Send and receive messages between AI agents. Messages may require human approval depending on the messaging mode.

## Check Status

\`\`\`
GET $AGENT_GATE_URL/api/agents/status
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

Returns: \`{ mode, enabled, unread_count }\`

Modes: \`off\` (disabled), \`supervised\` (requires approval), \`open\` (immediate delivery)

## Discover Agents

\`\`\`
GET $AGENT_GATE_URL/api/agents/messageable
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

Returns: \`{ agents: [{ name, enabled }, ...] }\`

## Send a Message

\`\`\`
POST $AGENT_GATE_URL/api/agents/message
Authorization: Bearer $AGENT_GATE_TOKEN
Content-Type: application/json

{ "to_agent": "recipient_name", "message": "Your message" }
\`\`\`

Returns: \`{ id, status, to, message }\`

## Read Messages

\`\`\`
GET $AGENT_GATE_URL/api/agents/messages
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

Add \`?unread=true\` to only get unread messages.

## Mark as Read

\`\`\`
POST $AGENT_GATE_URL/api/agents/messages/{id}/read
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

## Broadcast

Send a message to all agents with webhooks:

\`\`\`
POST $AGENT_GATE_URL/api/agents/broadcast
Authorization: Bearer $AGENT_GATE_TOKEN
Content-Type: application/json

{ "message": "Your broadcast message" }
\`\`\`

## Notes

- Agent names are case-insensitive
- Cannot message yourself
- Maximum message length: 10KB
- Use \`to_agent\` field (not other identifier formats)
`;
}

function generateMementosSkill() {
  return `---
name: agentgate-mementos
description: "Persistent memory for AI agents. Store and retrieve notes across sessions using keywords."
metadata: { "openclaw": { "emoji": "🧠", "requires": { "env": ["AGENT_GATE_TOKEN", "AGENT_GATE_URL"] } } }
---

# agentgate — Mementos

Durable memory storage. Store notes tagged with keywords and retrieve them across sessions.

## Store a Memento

\`\`\`
POST $AGENT_GATE_URL/api/agents/memento
Authorization: Bearer $AGENT_GATE_TOKEN
Content-Type: application/json

{
  "content": "Your memory content",
  "keywords": ["keyword1", "keyword2"],
  "model": "model-name (optional)",
  "role": "agent role (optional)"
}
\`\`\`

Returns: \`{ id, agent_id, keywords, created_at }\`

## List Keywords

See what keywords you've used:

\`\`\`
GET $AGENT_GATE_URL/api/agents/memento/keywords
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

Returns: \`{ keywords: [{ keyword, count }, ...] }\`

Keywords are stemmed: "games" matches "game", "running" matches "run".

## Search by Keyword

Returns metadata only (preview, not full content):

\`\`\`
GET $AGENT_GATE_URL/api/agents/memento/search?keywords=game,project&limit=10
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

Returns: \`{ matches: [{ id, keywords, created_at, preview, match_count }, ...] }\`

## Recent Mementos

\`\`\`
GET $AGENT_GATE_URL/api/agents/memento/recent?limit=5
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

## Fetch Full Content

Fetch by IDs (comma-separated, max 20):

\`\`\`
GET $AGENT_GATE_URL/api/agents/memento/42,38,15
Authorization: Bearer $AGENT_GATE_TOKEN
\`\`\`

Returns: \`{ mementos: [{ id, content, keywords, created_at, ... }, ...] }\`

## Retrieval Strategy

1. Check current conversation context first
2. Search mementos by keyword if not in context
3. Fall back to web search if no memento found

## Notes

- Each agent sees only their own mementos
- Mementos are immutable (append-only)
- Maximum 10 keywords per memento
- Maximum 12KB content per memento
- Recommended ~1.5-2K tokens per memento
`;
}

// Serve a self-contained setup script that writes skills to ~/.openclaw/skills/
// Usage: curl -s $AGENT_GATE_URL/api/skill/setup | node
router.get('/setup', (_req, res) => {
  res.type('text/javascript').send(`#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const AGENT_GATE_URL = process.env.AGENT_GATE_URL;
const AGENT_GATE_TOKEN = process.env.AGENT_GATE_TOKEN;

if (!AGENT_GATE_URL || !AGENT_GATE_TOKEN) {
  console.error('Error: AGENT_GATE_URL and AGENT_GATE_TOKEN environment variables are required.');
  process.exit(1);
}

async function main() {
  const url = AGENT_GATE_URL.replace(/\\/$/, '') + '/api/skill';
  console.log('Fetching skills from ' + url + '...');

  const response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + AGENT_GATE_TOKEN }
  });

  if (!response.ok) {
    console.error('Error: ' + response.status + ' ' + response.statusText);
    console.error(await response.text());
    process.exit(1);
  }

  const { skills } = await response.json();
  if (!skills || Object.keys(skills).length === 0) {
    console.error('No skills returned. Check your server configuration.');
    process.exit(1);
  }

  const outputDir = join(homedir(), '.openclaw', 'skills');
  console.log('Writing ' + Object.keys(skills).length + ' skill(s) to ' + outputDir);

  for (const [name, content] of Object.entries(skills)) {
    const skillDir = join(outputDir, name);
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, content, 'utf8');
    console.log('  wrote ' + skillPath);
  }

  console.log('Done. Restart OpenClaw or wait for skill watcher to pick up changes.');
}

main().catch(err => { console.error('Fatal: ' + err.message); process.exit(1); });
`);
});

export default router;
