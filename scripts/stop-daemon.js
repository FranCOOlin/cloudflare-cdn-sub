#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
const pidFile = path.join(dataDir, 'server.pid');

let pid = null;
try {
  pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
} catch {
  console.log('Server PID file not found.');
  process.exit(0);
}

try {
  process.kill(pid, 'SIGTERM');
  fs.rmSync(pidFile, { force: true });
  console.log(`Stopped server PID ${pid}`);
} catch (error) {
  fs.rmSync(pidFile, { force: true });
  console.log(`Server PID ${pid} was not running: ${error.message}`);
}
