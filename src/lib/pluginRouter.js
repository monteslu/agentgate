import { getLoadedPlugins } from './pluginLoader.js';
import { apiKeyAuth, writeProxy, serviceAccessCheck } from './middleware.js';
import { registerPlugin } from './serviceRegistry.js';

/**
 * Register all loaded plugin routes on the Express app
 * @param {import('express').Application} app - Express app instance
 */
export function registerPluginRoutes(app) {
  const plugins = getLoadedPlugins();

  for (const [name, plugin] of plugins) {
    // Register in service registry so MCP, skills, readme all pick it up
    // This will throw if the name collides with a built-in service
    try {
      registerPlugin(name, plugin.serviceInfo, plugin.readService);
    } catch (err) {
      console.warn(`Skipping plugin "${name}": ${err.message}`);
      continue;
    }

    // Mount Express router if plugin provides one
    if (plugin.router) {
      app.use(
        `/api/${name}`,
        apiKeyAuth,
        serviceAccessCheck(name),
        writeProxy(name),
        plugin.router
      );
      console.log(`Registered plugin routes: /api/${name}`);
    }
  }
}
