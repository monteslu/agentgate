import { Router } from 'express';
import { listMementos, getMementoById, deleteMemento, getMementoCounts, listApiKeys, getPendingQueueCount, listPendingMessages, getMessagingMode } from '../../lib/db.js';
import { escapeHtml, formatDate, renderAvatar } from './shared.js';
import { renderPage } from '../../lib/render.js';

const router = Router();

// GET /ui/mementos - Admin mementos list
router.get('/', (req, res) => {
  const { agent, keyword, limit = '50', offset = '0' } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);
  const parsedOffset = parseInt(offset, 10) || 0;

  const mementos = listMementos({
    agentId: agent || undefined,
    keyword: keyword || undefined,
    limit: parsedLimit,
    offset: parsedOffset
  });

  const agents = listApiKeys().map(k => k.name).sort();
  const counts = getMementoCounts();
  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = messagingMode !== 'off' ? listPendingMessages().length : 0;

  renderPage(res, 'pages/mementos', {
    title: 'Mementos',
    includeSocket: true,
    pendingQueueCount,
    pendingMessagesCount,
    messagingMode,
    mementos,
    agents,
    counts,
    agent: agent || '',
    keyword: keyword || '',
    parsedLimit,
    parsedOffset,
    renderAvatar,
    formatDate,
    escapeHtml
  });
});

// GET /ui/mementos/export - Export mementos as JSON
router.get('/export', (req, res) => {
  const { agent, keyword } = req.query;
  const mementos = listMementos({
    agentId: agent || undefined,
    keyword: keyword || undefined,
    limit: 10000
  });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="mementos-export.json"');
  res.json(mementos);
});

// POST /ui/mementos/:id/delete - Delete a memento
router.post('/:id/delete', (req, res) => {
  const { id } = req.params;
  const wantsJson = req.headers.accept?.includes('application/json');

  const memento = getMementoById(parseInt(id, 10));
  if (!memento) {
    return wantsJson
      ? res.status(404).json({ error: 'Memento not found' })
      : res.status(404).send('Memento not found');
  }

  deleteMemento(parseInt(id, 10));

  if (wantsJson) {
    return res.json({ success: true });
  }
  res.redirect('/ui/mementos');
});

// GET /ui/mementos/:id - View single memento
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const memento = getMementoById(parseInt(id, 10));

  if (!memento) {
    return res.render('pages/error', {
      title: 'Memento Not Found',
      message: `No memento with ID ${escapeHtml(id)} exists.`,
      backUrl: '/ui/mementos',
      backText: '← Back to Mementos'
    });
  }

  const pendingQueueCount = getPendingQueueCount();
  const messagingMode = getMessagingMode();
  const pendingMessagesCount = messagingMode !== 'off' ? listPendingMessages().length : 0;

  renderPage(res, 'pages/memento-detail', {
    title: `Memento #${memento.id}`,
    includeSocket: true,
    pendingQueueCount,
    pendingMessagesCount,
    messagingMode,
    memento,
    renderAvatar,
    formatDate,
    escapeHtml
  });
});

export default router;
