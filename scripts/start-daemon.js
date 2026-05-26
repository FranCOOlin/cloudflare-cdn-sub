#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
const pidFile = path.join(dataDir, 'server.pid');
const logFile = path.join(dataDir, 'server.log');

fs.mkdirSync(dataDir, { recursive: true });

const existingPid = readPid();
if (existingPid && isRunning(existingPid)) {
  console.log(`Server already running with PID ${existingPid}`);
  process.exit(0);
}

const logFd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['src/server/index.js'], {
  cwd: projectRoot,
  detached: true,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['ignore', logFd, logFd]
});

child.unref();
fs.writeFileSync(pidFile, String(child.pid));
console.log(`Server started with PID ${child.pid}`);
console.log(`Log file: ${logFile}`);

function readPid() {
  try {
    return Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
