/**
 * Header forwarding utilities for service routes.
 *
 * Agents send requests to agentgate with their own Authorization header
 * (the agentgate bearer token) plus any custom headers they want forwarded
 * to upstream APIs (Accept, If-None-Match, X-GitHub-Api-Version, etc.).
 *
 * This module strips the agentgate auth and hop-by-hop headers, returning
 * clean headers that can be merged with service-specific defaults.
 */

// Hop-by-hop headers per RFC 2616 Section 13.5.1
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

// Headers that should never be forwarded to upstream services
const STRIP_HEADERS = new Set([
  'authorization',       // agentgate bearer token — replaced with service creds
  'host',                // must reflect upstream target, not agentgate
  'content-length',      // may differ after body transformation
  'x-agentgate-raw'    // internal agentgate header
]);

/**
 * Extract forwardable headers from an incoming request.
 *
 * @param {object} reqHeaders - The raw req.headers from Express
 * @returns {object} Cleaned headers safe to forward upstream
 */
export function getForwardableHeaders(reqHeaders) {
  if (!reqHeaders || typeof reqHeaders !== 'object') return {};

  const forwarded = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (STRIP_HEADERS.has(lower)) continue;
    forwarded[key] = value;
  }
  return forwarded;
}

/**
 * Merge service-specific default headers with agent-forwarded headers.
 * Agent headers take precedence — defaults only apply if the agent
 * didn't already set them.
 *
 * @param {object} defaults - Service-specific default headers
 * @param {object} forwarded - Agent-forwarded headers (from getForwardableHeaders)
 * @returns {object} Merged headers
 */
export function mergeHeaders(defaults, forwarded) {
  // Start with defaults, then overlay agent headers
  // We need case-insensitive comparison
  const merged = { ...defaults };
  const defaultKeysLower = new Map(
    Object.keys(defaults).map(k => [k.toLowerCase(), k])
  );

  for (const [key, value] of Object.entries(forwarded)) {
    const lower = key.toLowerCase();
    // If the agent set a header that exists in defaults, remove the default key
    // and use the agent's version
    const existingKey = defaultKeysLower.get(lower);
    if (existingKey && existingKey !== key) {
      delete merged[existingKey];
    }
    merged[key] = value;
  }

  return merged;
}
