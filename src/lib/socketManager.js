import { Server } from 'socket.io';
import { getQueueCounts, getMessageCounts, getMessagingMode } from './db.js';

let io = null;

/**
 * Initialize socket.io with the HTTP server
 * @param {import('http').Server} server - The HTTP server instance
 */
export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    // Send current counts immediately on connect
    socket.emit('counts', getCurrentCounts());

    socket.on('disconnect', () => {
      // Client disconnected
    });
  });

  return io;
}

/**
 * Get current counts for queue and messages
 */
function getCurrentCounts() {
  const queueCounts = getQueueCounts();
  const messageCounts = getMessageCounts();
  const messagingMode = getMessagingMode();

  return {
    queue: {
      pending: queueCounts.pending,
      total: queueCounts.all
    },
    messages: {
      pending: messageCounts.pending,
      unread: messageCounts.delivered,
      total: messageCounts.all
    },
    messagingEnabled: messagingMode !== 'off'
  };
}

/**
 * Emit count update to all connected clients
 * Call this whenever queue or message counts change
 */
export function emitCountUpdate() {
  if (io) {
    io.emit('counts', getCurrentCounts());
  }
}

/**
 * Emit a specific event to all connected clients
 * @param {string} event - Event name
 * @param {any} data - Event data
 */
export function emitEvent(event, data) {
  if (io) {
    io.emit(event, data);
  }
}

export { io };
