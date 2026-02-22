# Plugin Security & Trust Model

## Overview

AgentGate's plugin system loads and executes custom JavaScript modules from the filesystem at server startup. This document describes the trust boundaries and security considerations.

## Trust Model

**Installing a plugin is equivalent to granting it full server privileges.**

Plugins are loaded via dynamic `import()` and run in the same Node.js process as AgentGate. A plugin has access to:

- The full Node.js runtime (filesystem, network, child processes)
- All environment variables (including API keys and secrets)
- The Express app and all middleware
- The AgentGate database (via imported modules)

There is **no sandboxing** in v1. This is a deliberate design choice — sandboxing JavaScript in-process is complex and fragile, and plugins need access to Node.js APIs to be useful.

## Protections

### What AgentGate does protect against:

1. **Authentication**: Plugin routes go through the same `apiKeyAuth` middleware as built-in services. Unauthenticated requests are rejected.

2. **Write control**: Plugin routes use `writeProxy` middleware, so write operations (POST/PUT/PATCH/DELETE) go through the human-in-the-loop approval queue — same as built-in services.

3. **Access control**: Plugin routes use `serviceAccessCheck` middleware, so per-agent service access restrictions apply.

4. **Name collision prevention**: `registerPlugin()` checks that the plugin name doesn't collide with built-in services (`github`, `calendar`, etc.) or reserved API paths (`queue`, `agents`, `services`, etc.). A plugin named `github` or `agents` will be rejected at load time.

5. **Manifest validation**: Plugin manifests are validated for required fields, name format (lowercase alphanumeric), and semver version format before loading.

### What AgentGate does NOT protect against:

1. **Malicious plugin code**: A plugin can read/write any file, make network requests, access environment variables, or modify the server's behavior in arbitrary ways.

2. **Integrity verification**: There are no checksums, signatures, or allowlisting of plugin sources. Any code placed in the plugins directory will be loaded.

3. **Runtime isolation**: Plugins share memory, event loop, and all resources with the main process. A plugin that blocks the event loop or crashes will affect the entire server.

## Recommendations

- **Only install plugins from trusted sources.** Treat plugin installation like installing a Node.js package with `--global` — it can do anything.
- **Review plugin source code** before installing, especially `handler.js`/`handler.mjs`.
- **Use a dedicated user** to run AgentGate if you install third-party plugins, to limit filesystem access.
- **Monitor server logs** for unexpected behavior after installing plugins.

## Plugin Directory

Plugins are loaded from `~/.agentgate/plugins/` (or `AGENTGATE_PLUGINS_DIR` env var). Each plugin is a directory containing:

```
~/.agentgate/plugins/
  my-plugin/
    manifest.json    # Plugin metadata (name, version, auth config)
    handler.mjs      # Plugin code (ESM module)
```

## Future Considerations

- **Plugin signatures**: Verify plugin integrity via checksums or GPG signatures
- **Permission declarations**: Manifest-declared capabilities (filesystem, network, etc.)
- **Admin UI**: List loaded plugins, enable/disable without removing files
- **Hot reload**: Load/unload plugins without server restart
