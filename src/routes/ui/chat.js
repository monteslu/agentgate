// Admin chat UI for channel-enabled agents
import { Router } from 'express';
import { listChannels, getApiKeyById } from '../../lib/db.js';
import { renderPage } from '../../lib/render.js';
import { hasChannelAgent } from '../channel-bridge.js';
import { generateAdminChatToken } from './keys.js';
import { escapeHtml, formatDate, renderAvatar } from './shared.js';

const router = Router();

function normalizeChannel(agent) {
  const channelId = agent.channel_id;
  return {
    ...agent,
    connected: channelId ? hasChannelAgent(channelId) : false
  };
}

router.get('/', (req, res) => {
  const channels = listChannels().map(normalizeChannel);
  const selectedId = req.query.agent || channels[0]?.id || null;
  const selected = channels.find((agent) => String(agent.id) === String(selectedId)) || channels[0] || null;

  renderPage(res, 'pages/chat', {
    title: 'Chat',
    includeSocket: true,
    includeMarkdown: true,
    channels,
    selected,
    escapeHtml,
    formatDate,
    renderAvatar
  });
});

router.post('/:id/token', (req, res) => {
  const agent = getApiKeyById(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (!agent.channel_enabled || !agent.channel_id) {
    return res.status(400).json({ error: 'Channel not enabled for this agent' });
  }

  res.json({
    token: generateAdminChatToken(agent.channel_id),
    channelId: agent.channel_id,
    agent: {
      id: agent.id,
      name: agent.name,
      connected: hasChannelAgent(agent.channel_id)
    }
  });
});

export default router;
