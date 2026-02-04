#!/usr/bin/env node

import { createApiKey, listApiKeys, deleteApiKey } from './lib/db.js';

const [,, command, ...args] = process.argv;

function printUsage() {
  console.log(`
Usage: node src/cli.js <command>

Commands:
  list                  List all API keys
  create <name>         Create a new API key
  delete <id>           Delete an API key by ID
`);
}

async function main() {
  switch (command) {
  case 'list': {
    const keys = listApiKeys();
    if (keys.length === 0) {
      console.log('No API keys found.');
    } else {
      console.log('\nAPI Keys:\n');
      for (const k of keys) {
        console.log(`  ID:      ${k.id}`);
        console.log(`  Name:    ${k.name}`);
        console.log(`  Key:     ${k.key_prefix} (hashed - full key shown only at creation)`);
        console.log(`  Created: ${k.created_at}`);
        console.log('');
      }
    }
    break;
  }

  case 'create': {
    const name = args[0];
    if (!name) {
      console.error('Error: name required\n');
      console.log('Usage: node src/cli.js create <name>');
      process.exit(1);
    }
    const key = await createApiKey(name);
    console.log('\nAPI key created:\n');
    console.log(`  Name: ${key.name}`);
    console.log(`  Key:  ${key.key}`);
    console.log('\n  ⚠️  Save this key now - you won\'t be able to see it again!\n');
    break;
  }

  case 'delete': {
    const id = args[0];
    if (!id) {
      console.error('Error: id required\n');
      console.log('Usage: node src/cli.js delete <id>');
      process.exit(1);
    }
    const result = deleteApiKey(id);
    if (result.changes > 0) {
      console.log(`API key ${id} deleted.`);
    } else {
      console.log(`No API key found with ID: ${id}`);
    }
    break;
  }

  default:
    printUsage();
    break;
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
