// Route Registry — aggregates routeMeta from all route files
import { routeMeta as agentsMeta } from '../routes/agents.js';
import { routeMeta as queueMeta } from '../routes/queue.js';
import { routeMeta as mementoMeta } from '../routes/memento.js';
import { routeMeta as llmMeta } from '../routes/llm.js';
import { routeMeta as channelMeta } from '../routes/channel.js';
import { routeMeta as webhooksMeta } from '../routes/webhooks.js';
import { routeMeta as servicesMeta } from '../routes/services.js';
import { routeMeta as skillMeta } from '../routes/skill.js';
import { routeMeta as mcpMeta } from '../routes/mcp.js';

export const ROUTE_REGISTRY = [
  agentsMeta,
  queueMeta,
  mementoMeta,
  llmMeta,
  channelMeta,
  webhooksMeta,
  servicesMeta,
  skillMeta,
  mcpMeta
];

export function getRouteRegistry() {
  return ROUTE_REGISTRY;
}
