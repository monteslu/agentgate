#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const [,, command, ...args] = process.argv;

function printUsage() {
  console.log(`
agentgate - API gateway for AI agents with human-in-the-loop write approval

Usage: agentgate <command> [options]

Commands:
  start                 Start the agentgate server
  keys list             List all API keys
  keys create <name>    Create a new API key
  keys delete <id>      Delete an API key by ID

Options:
  -p, --port <port>     Port to run server on (default: 3050, or PORT env)
  -h, --help            Show this help message

Environment:
  PORT                  Server port (default: 3050)
  AGENTGATE_DATA_DIR    Data directory (default: ~/.agentgate/)

Examples:
  agentgate start
  agentgate start --port 8080
  agentgate keys create my-agent
  agentgate keys list
`);
}

async function main() {
  if (!command || command === '-h' || command === '--help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'start') {
    // Parse port from args
    const portIdx = args.findIndex(a => a === '-p' || a === '--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      process.env.PORT = args[portIdx + 1];
    }
    
    // Import and run the server
    await import('./index.js');
  } else if (command === 'keys') {
    const subcommand = args[0];
    const { createApiKey, listApiKeys, deleteApiKey } = await import('./lib/db.js');
    
    switch (subcommand) {
    case 'list': {
      const keys = listApiKeys();
      if (keys.length === 0) {
        console.log('No API keys found.');
      } else {
        console.log('\nAPI Keys:\n');
        for (const k of keys) {
          console.log(`  ID:      ${k.id}`);
          console.log(`  Name:    ${k.name}`);
          console.log(`  Prefix:  ${k.key_prefix}...`);
          console.log(`  Created: ${k.created_at}`);
          console.log('');
        }
      }
      break;
    }
    case 'create': {
      const name = args[1];
      if (!name) {
        console.error('Error: Please provide a name for the API key');
        console.error('Usage: agentgate keys create <name>');
        process.exit(1);
      }
      const result = createApiKey(name);
      console.log('\n✅ API key created!\n');
      console.log(`  Name: ${name}`);
      console.log(`  Key:  ${result.key}`);
      console.log('\n⚠️  Save this key now - it cannot be retrieved later!\n');
      break;
    }
    case 'delete': {
      const id = args[1];
      if (!id) {
        console.error('Error: Please provide the ID of the key to delete');
        console.error('Usage: agentgate keys delete <id>');
        process.exit(1);
      }
      deleteApiKey(id);
      console.log(`\n✅ API key ${id} deleted.\n`);
      break;
    }
    default:
      console.error(`Unknown keys subcommand: ${subcommand}`);
      console.error('Available: list, create, delete');
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
