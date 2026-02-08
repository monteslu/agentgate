import { Router } from 'express';
import { getAccountsByService } from '../lib/db.js';
import SERVICE_REGISTRY from '../lib/serviceRegistry.js';

const router = Router();
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3050}`;

// Generate SKILL.md for OpenClaw/AgentSkills compatible systems
// See: https://docs.openclaw.ai/tools/skills
router.get('/', (req, res) => {
  const baseUrl = req.query.base_url || BASE_URL;
  const accountsByService = getAccountsByService();

  // Build list of configured services dynamically
  const configuredServices = [];
  for (const [serviceKey, info] of Object.entries(SERVICE_REGISTRY)) {
    const dbKey = info.dbKey || serviceKey;
    const accounts = accountsByService[dbKey] || [];
    if (accounts.length > 0) {
      configuredServices.push(`- **${info.name}**: ${accounts.join(', ')}`);
    }
  }

  // Build supported services list for description
  const supportedServices = Object.values(SERVICE_REGISTRY).map(s => s.name).join(', ');

  // Generate example read endpoints from configured services
  const readExamples = [];
  for (const [serviceKey, info] of Object.entries(SERVICE_REGISTRY)) {
    const dbKey = info.dbKey || serviceKey;
    const accounts = accountsByService[dbKey] || [];
    if (accounts.length > 0 && info.examples && info.examples.length > 0) {
      // Take first example, replace {accountName} with actual account
      const example = info.examples[0].replace('{accountName}', accounts[0]);
      readExamples.push(`- \`${example.replace('GET ', baseUrl)}\``);
      if (readExamples.length >= 3) break;
    }
  }

  // Collect any write guidelines
  const writeGuidelines = [];
  for (const [_serviceKey, info] of Object.entries(SERVICE_REGISTRY)) {
    if (info.writeGuidelines) {
      writeGuidelines.push(`### ${info.name}\n${info.writeGuidelines.map(g => `- ${g}`).join('\n')}`);
    }
  }

  const skillMd = `---
name: agentgate
description: Access personal data through agentgate API gateway. Supports ${supportedServices}. Read requests execute immediately. Write requests are queued for human approval.
metadata: { "openclaw": { "emoji": "🚪", "requires": { "env": ["AGENTGATE_API_KEY"] } } }
---

# agentgate

API gateway for accessing personal data with human-in-the-loop write approval.

## Configuration

- **Base URL**: \`${baseUrl}\`
- **API Key**: Use the \`AGENTGATE_API_KEY\` environment variable

## Configured Services

${configuredServices.length > 0 ? configuredServices.join('\n') : '_No services configured yet_'}

## Authentication

All requests require the API key in the Authorization header:

\`\`\`
Authorization: Bearer $AGENTGATE_API_KEY
\`\`\`

## Read Requests (Immediate)

Make GET requests to \`${baseUrl}/api/{service}/{accountName}/...\`

${readExamples.length > 0 ? 'Examples:\n' + readExamples.join('\n') : ''}

## Write Requests (Queued for Approval)

Write operations (POST/PUT/DELETE) must go through the queue:

1. **Submit request**:
   \`\`\`
   POST ${baseUrl}/api/queue/{service}/{accountName}/submit
   {
     "requests": [{ "method": "POST", "path": "/path", "body": {...} }],
     "comment": "Explain what you're doing and why. Include [links](url) to relevant issues/PRs."
   }
   \`\`\`

2. **Poll for status**:
   \`\`\`
   GET ${baseUrl}/api/queue/{service}/{accountName}/status/{id}
   \`\`\`

3. **Check response**: \`pending\`, \`completed\`, \`failed\`, or \`rejected\` (with reason)

## Binary Uploads

For binary data (images, files), set \`binaryBase64: true\` in the request:

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

- Always include a clear comment explaining your intent
- Include markdown links to relevant resources (issues, PRs, docs)
- Be patient - approval requires human action
- For binary uploads, encode data as base64 and set binaryBase64: true

${writeGuidelines.length > 0 ? '## Service-Specific Guidelines\n\n' + writeGuidelines.join('\n\n') : ''}

## Full API Documentation

For complete endpoint documentation, fetch:
\`\`\`
GET ${baseUrl}/api/readme
\`\`\`
`;

  res.type('text/markdown').send(skillMd);
});

export default router;
