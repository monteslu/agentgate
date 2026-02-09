// Service listing service layer - shared business logic for HTTP and MCP
import {
  listServicesWithAccess,
  checkServiceAccess,
  checkBypassAuth
} from '../lib/db.js';
import SERVICE_REGISTRY from '../lib/serviceRegistry.js';

/**
 * List services accessible by an agent
 * @param {string} agentName - Agent name
 * @param {Object} options - Options
 * @param {boolean} options.includeDocs - Include docs URL and examples (default: false for backwards compat)
 * @returns {Array} Array of service objects with access info
 */
export function listAccessibleServices(agentName, options = {}) {
  const { includeDocs = false } = options;
  const allServices = listServicesWithAccess();

  // Filter to only show services the agent has access to
  // And include bypass_auth status for this agent
  const accessibleServices = allServices
    .filter(svc => {
      const access = checkServiceAccess(svc.service, svc.account_name, agentName);
      return access.allowed;
    })
    .map(svc => {
      const result = {
        ...svc,
        bypass_auth: agentName ? checkBypassAuth(svc.service, svc.account_name, agentName) : false
      };

      // Add docs and examples from registry if requested
      if (includeDocs) {
        const registryInfo = SERVICE_REGISTRY[svc.service];
        if (registryInfo) {
          result.base_path = `/api/${svc.service}/${svc.account_name}`;
          result.docs = registryInfo.docs;
          result.examples = registryInfo.examples;
          if (registryInfo.writeGuidelines) {
            result.write_guidelines = registryInfo.writeGuidelines;
          }
        }
      }

      return result;
    });

  return accessibleServices;
}

/**
 * Get access info for a specific service/account
 * @param {string} agentName - Agent name
 * @param {string} service - Service name
 * @param {string} account - Account name
 * @returns {Object} Access info object
 * @throws {Error} If agent doesn't have access
 */
export function getServiceAccess(agentName, service, account) {
  // Check if agent has access to this service
  const accessCheck = checkServiceAccess(service, account, agentName);
  if (!accessCheck.allowed) {
    const error = new Error(`You do not have access to ${service}/${account}`);
    error.reason = accessCheck.reason;
    throw error;
  }

  // Return the calling agent's own access info
  const agentBypass = agentName ? checkBypassAuth(service, account, agentName) : false;

  return {
    service,
    account_name: account,
    your_access: {
      allowed: true,
      bypass_auth: agentBypass
    }
  };
}

/**
 * Check bypass_auth status for an agent
 * @param {string} agentName - Agent name
 * @param {string} service - Service name
 * @param {string} account - Account name
 * @returns {Object} Bypass status object
 */
export function checkBypassStatus(agentName, service, account) {
  const hasBypass = checkBypassAuth(service, account, agentName);
  return {
    service,
    account,
    agent: agentName,
    bypass_auth: hasBypass
  };
}
