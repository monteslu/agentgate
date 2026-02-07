// Shared constants and helpers for UI routes

export const AUTH_COOKIE = 'rms_auth';
export const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 1 week

export const PORT = process.env.PORT || 3050;
export const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// HTML escape helper
export function escapeHtml(str) {
  if (typeof str !== 'string') str = JSON.stringify(str, null, 2);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render markdown links [text](url) while escaping everything else
export function renderMarkdownLinks(str) {
  if (!str) return '';
  let escaped = escapeHtml(str);
  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return escaped;
}

// Generate a consistent color from a string (for avatar fallback)
export function stringToColor(str) {
  if (!str) return '#6b7280';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 60%, 45%)`;
}

// Render agent avatar with fallback to initials
export function renderAvatar(agentName, { size = 32, className = '' } = {}) {
  if (!agentName) return '';
  const safeName = escapeHtml(agentName);
  const initial = agentName.charAt(0).toUpperCase();
  const color = stringToColor(agentName);
  
  return `<span class="avatar ${className}" style="width: ${size}px; height: ${size}px; background-color: ${color};" data-agent="${safeName}">
    <img src="/ui/keys/avatar/${encodeURIComponent(agentName)}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
    <span class="avatar-initials" style="display: none;">${initial}</span>
  </span>`;
}

// Status badge HTML
export function statusBadge(status) {
  const colors = {
    pending: 'background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);',
    approved: 'background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);',
    executing: 'background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);',
    completed: 'background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);',
    failed: 'background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);',
    rejected: 'background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3);',
    withdrawn: 'background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3);',
    delivered: 'background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);'
  };
  return `<span class="status" style="${colors[status] || ''}">${status}</span>`;
}

// Format date for display - outputs span with data-utc for client-side localization
export function formatDate(dateStr) {
  if (!dateStr) return '';
  // Return span with UTC timestamp - client JS will localize
  return `<span class="local-time" data-utc="${dateStr}"></span>`;
}

// Client-side script to localize all dates to browser timezone
export function localizeScript() {
  return `
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      document.querySelectorAll('.local-time[data-utc]').forEach(function(el) {
        const utc = el.getAttribute('data-utc');
        if (utc) {
          const d = new Date(utc);
          el.textContent = d.toLocaleString();
          el.title = utc + ' UTC';
        }
      });
    });
  </script>`;
}

// Shared HTML head with common styles/scripts
export function htmlHead(title, { includeSocket = false } = {}) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - ${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <link rel="stylesheet" href="/public/mobile.css">
  ${includeSocket ? '<script src="/socket.io/socket.io.js"></script>' : ''}
</head>`;
}

// Navigation header with real-time badge support
export function navHeader({ pendingQueueCount = 0, pendingMessagesCount = 0, messagingMode = 'off' } = {}) {
  return `
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <img src="/public/favicon.svg" alt="agentgate" style="height: 64px;">
      <h1 style="margin: 0;">agentgate</h1>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">Agents</a>
      <a href="/ui/access" class="nav-btn nav-btn-default">Access</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        <span id="queue-badge" class="badge" ${pendingQueueCount > 0 ? '' : 'style="display:none"'}>${pendingQueueCount}</span>
      </a>
      <a href="/ui/messages" id="messages-nav" class="nav-btn nav-btn-default" style="position: relative;${messagingMode === 'off' ? ' display:none;' : ''}">
        Messages
        <span id="messages-badge" class="badge" ${pendingMessagesCount > 0 ? '' : 'style="display:none"'}>${pendingMessagesCount}</span>
      </a>
      <a href="/ui/mementos" class="nav-btn nav-btn-default">Mementos</a>
      <div class="nav-divider"></div>
      <a href="/ui#settings" class="nav-btn nav-btn-default" title="Settings" style="font-size: 18px;">⚙️</a>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="nav-btn nav-btn-default" style="color: #f87171;">Logout</button>
      </form>
    </div>
  </div>`;
}

// Socket.io client script for real-time badge updates
export function socketScript() {
  return `
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      const socket = io();

      socket.on('counts', function(data) {
        // Update queue badge
        const queueBadge = document.getElementById('queue-badge');
        if (queueBadge) {
          if (data.queue.pending > 0) {
            queueBadge.textContent = data.queue.pending;
            queueBadge.style.display = '';
          } else {
            queueBadge.style.display = 'none';
          }
        }

        // Update messages badge
        const msgBadge = document.getElementById('messages-badge');
        if (msgBadge) {
          if (data.messages.pending > 0) {
            msgBadge.textContent = data.messages.pending;
            msgBadge.style.display = '';
          } else {
            msgBadge.style.display = 'none';
          }
        }

        // Show/hide messages nav based on messaging mode
        const msgNav = document.getElementById('messages-nav');
        if (msgNav) {
          msgNav.style.display = data.messagingEnabled ? '' : 'none';
        }
      });

      socket.on('connect', function() {
        console.log('Socket.io connected for real-time updates');
      });
    });
  </script>`;
}

// Copy text helper script
export function copyScript() {
  return `
  <script>
    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }
  </script>`;
}

// Styled error page for OAuth callbacks and other errors
export function renderErrorPage(title, message, { backUrl = '/ui', backText = 'Back to Settings' } = {}) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>agentgate - ${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="stylesheet" href="/public/style.css">
  <style>
    .error-container {
      max-width: 500px;
      margin: 80px auto;
      padding: 32px;
      text-align: center;
    }
    .error-icon {
      font-size: 64px;
      margin-bottom: 16px;
    }
    .error-title {
      color: #f87171;
      margin-bottom: 16px;
    }
    .error-message {
      color: #9ca3af;
      margin-bottom: 24px;
      line-height: 1.6;
      word-break: break-word;
    }
    .error-actions {
      display: flex;
      gap: 12px;
      justify-content: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-container">
      <div class="error-icon">⚠️</div>
      <h1 class="error-title">${escapeHtml(title)}</h1>
      <p class="error-message">${escapeHtml(message)}</p>
      <div class="error-actions">
        <a href="${escapeHtml(backUrl)}" class="btn btn-primary">${escapeHtml(backText)}</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// Simple navigation header for sub-pages (includes badge elements for socket.io updates)
export function simpleNavHeader({ pendingQueueCount = 0, pendingMessagesCount = 0, messagingMode = 'off' } = {}) {
  return `
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <a href="/ui" style="display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit;">
        <img src="/public/favicon.svg" alt="agentgate" style="height: 48px;">
        <h1 style="margin: 0;">agentgate</h1>
      </a>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <a href="/ui/keys" class="nav-btn nav-btn-default">Agents</a>
      <a href="/ui/access" class="nav-btn nav-btn-default">Access</a>
      <a href="/ui/queue" class="nav-btn nav-btn-default" style="position: relative;">
        Write Queue
        <span id="queue-badge" class="badge" ${pendingQueueCount > 0 ? '' : 'style="display:none"'}>${pendingQueueCount}</span>
      </a>
      <a href="/ui/messages" id="messages-nav" class="nav-btn nav-btn-default" style="position: relative;${messagingMode === 'off' ? ' display:none;' : ''}">
        Messages
        <span id="messages-badge" class="badge" ${pendingMessagesCount > 0 ? '' : 'style="display:none"'}>${pendingMessagesCount}</span>
      </a>
      <a href="/ui/mementos" class="nav-btn nav-btn-default">Mementos</a>
      <div class="nav-divider"></div>
      <a href="/ui#settings" class="nav-btn nav-btn-default" title="Settings" style="font-size: 18px;">⚙️</a>
      <form method="POST" action="/ui/logout" style="margin: 0;">
        <button type="submit" class="nav-btn nav-btn-default" style="color: #f87171;">Logout</button>
      </form>
    </div>
  </div>`;
}
