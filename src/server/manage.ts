import { loadConfig } from './config.js';
import { Store } from './store.js';

const config = loadConfig();
const store = new Store(config.dataDir);
try {
  const [command, id] = process.argv.slice(2);
  if (command === 'pair') {
    const pair = store.issuePairCode();
    console.log(`Pairing code: ${pair.code}\nExpires: ${new Date(pair.expiresAt).toISOString()}\nUse once in your PocketAgent browser. Do not share this code.`);
  } else if (command === 'devices') {
    const devices = store.devices();
    if (!devices.length) console.log('No paired devices.');
    else for (const device of devices) console.log(`${device.id}\t${device.name}\t${new Date(device.expiresAt).toISOString()}`);
  } else if (command === 'revoke' && id) {
    store.revoke(id);
    console.log('Device access revoked.');
  } else {
    console.error('Usage: npm run pair | npm run devices | npm run revoke -- <device-id|all>');
    process.exitCode = 1;
  }
} catch {
  console.error('MANAGEMENT_COMMAND_FAILED');
  process.exitCode = 1;
} finally { store.close(); }
