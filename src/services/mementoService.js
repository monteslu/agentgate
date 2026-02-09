// Memento service layer - shared business logic for HTTP and MCP
import {
  createMemento,
  getMementoKeywords,
  searchMementos,
  getRecentMementos,
  getMementosById
} from '../lib/db.js';

/**
 * Save a memento
 * @param {string} agentName - Agent name
 * @param {string} content - Memento content
 * @param {Array<string>} keywords - Array of keywords
 * @param {string} model - Optional model name
 * @param {string} role - Optional role
 * @returns {Object} Created memento object
 * @throws {Error} If validation fails
 */
export function saveMemento(agentName, content, keywords, model = null, role = null) {
  if (!content) {
    throw new Error('Missing "content" field');
  }

  if (!keywords || !Array.isArray(keywords)) {
    throw new Error('Missing or invalid "keywords" field (must be an array)');
  }

  return createMemento(agentName, content, keywords, { model, role });
}

/**
 * Search mementos by keywords
 * @param {string} agentName - Agent name
 * @param {Array<string>} keywords - Array of keywords to search
 * @param {number} limit - Optional result limit (default: 10, max: 100)
 * @returns {Array} Array of matching mementos
 * @throws {Error} If validation fails
 */
export function searchMementosByKeywords(agentName, keywords, limit = 10) {
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    throw new Error('keywords must be a non-empty array');
  }

  const options = {};
  if (limit) {
    const parsedLimit = parseInt(limit, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      options.limit = Math.min(parsedLimit, 100); // Cap at 100
    }
  }

  return searchMementos(agentName, keywords, options);
}

/**
 * Get all keywords for an agent's mementos
 * @param {string} agentName - Agent name
 * @returns {Array<string>} Array of unique keywords
 */
export function listMementoKeywords(agentName) {
  return getMementoKeywords(agentName);
}

/**
 * Get recent mementos for an agent
 * @param {string} agentName - Agent name
 * @param {number} limit - Optional result limit (default: 5, max: 20)
 * @returns {Array} Array of recent mementos
 */
export function listRecentMementos(agentName, limit = 5) {
  let parsedLimit = 5;
  if (limit) {
    const l = parseInt(limit, 10);
    if (!isNaN(l) && l > 0) {
      parsedLimit = Math.min(l, 20); // Cap at 20
    }
  }

  return getRecentMementos(agentName, parsedLimit);
}

/**
 * Get mementos by IDs
 * @param {string} agentName - Agent name
 * @param {Array<string>} ids - Array of memento IDs
 * @returns {Array} Array of mementos
 * @throws {Error} If validation fails
 */
export function getMementosByIds(agentName, ids) {
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids must be a non-empty array');
  }

  if (ids.length > 20) {
    throw new Error('Cannot fetch more than 20 mementos at once');
  }

  return getMementosById(agentName, ids);
}
