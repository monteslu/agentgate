/**
 * Channel Bridge - coordinates communication between human and agent connections.
 * 
 * Humans connect to /channel/<id>, agents connect to /api/channel/<id>.
 * This module manages the message passing between them.
 */

import { createWebSocketFrame } from '../lib/ws-utils.js';

// Store channel bridges
// channelId -> { humans: Map<connId, socket>, agent: socket | null, messageQueue: [] }
const bridges = new Map();

/**
 * Send JSON message to socket
 */
function sendToSocket(socket, msg) {
  if (socket && socket.writable) {
    socket.write(createWebSocketFrame(JSON.stringify(msg)));
  }
}

/**
 * Get or create a channel bridge
 */
export function getChannelBridge(channelId) {
  if (!bridges.has(channelId)) {
    bridges.set(channelId, {
      humans: new Map(),
      agent: null,
      messageQueue: [] // Buffer messages when agent disconnected
    });
  }
  
  const bridge = bridges.get(channelId);
  
  return {
    // Human management
    addHuman(connId, socket) {
      bridge.humans.set(connId, socket);
      // Notify agent if connected
      if (bridge.agent) {
        sendToSocket(bridge.agent, { type: 'human_connected', connId });
      }
    },
    
    removeHuman(connId) {
      bridge.humans.delete(connId);
      // Notify agent if connected
      if (bridge.agent) {
        sendToSocket(bridge.agent, { type: 'human_disconnected', connId });
      }
      // Cleanup empty bridge
      if (bridge.humans.size === 0 && !bridge.agent) {
        bridges.delete(channelId);
      }
    },
    
    getHumanCount() {
      return bridge.humans.size;
    },
    
    getHumanConnIds() {
      return Array.from(bridge.humans.keys());
    },
    
    // Agent management
    setAgent(socket) {
      if (bridge.agent) {
        return false; // Already has agent
      }
      bridge.agent = socket;
      
      // Send queued messages
      for (const msg of bridge.messageQueue) {
        sendToSocket(socket, msg);
      }
      bridge.messageQueue = [];
      
      // Send current human list
      sendToSocket(socket, {
        type: 'connected',
        channelId,
        humans: Array.from(bridge.humans.keys())
      });
      
      return true;
    },
    
    removeAgent() {
      bridge.agent = null;
      // Notify all humans
      for (const [, socket] of bridge.humans) {
        sendToSocket(socket, { type: 'agent_disconnected' });
      }
      // Cleanup empty bridge
      if (bridge.humans.size === 0) {
        bridges.delete(channelId);
      }
    },
    
    hasAgent() {
      return bridge.agent !== null;
    },
    
    // Messaging
    sendToAgent(msg) {
      if (bridge.agent) {
        sendToSocket(bridge.agent, msg);
      } else {
        // Queue message for when agent connects (limit queue size)
        if (bridge.messageQueue.length < 100) {
          bridge.messageQueue.push(msg);
        }
      }
    },
    
    sendToHuman(connId, msg) {
      const socket = bridge.humans.get(connId);
      if (socket) {
        sendToSocket(socket, msg);
      }
    },
    
    broadcastToHumans(msg) {
      const frame = createWebSocketFrame(JSON.stringify(msg));
      for (const [, socket] of bridge.humans) {
        if (socket && socket.writable) {
          socket.write(frame);
        }
      }
    }
  };
}

/**
 * Check if a channel has any connections
 */
export function hasChannelConnections(channelId) {
  const bridge = bridges.get(channelId);
  if (!bridge) return false;
  return bridge.humans.size > 0 || bridge.agent !== null;
}

export default { getChannelBridge, hasChannelConnections };
