#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { buildCfstArgs, defaultIpFileFor, normalizeCfstParams } from '../shared/cfst.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const args = parseArgs(process.argv.slice(2));
const server = requireArg(args.server, '--server');
const token = requireArg(args.token || process.env.AGENT_TOKEN, '--token');
const name = args.name || os.hostname();
const cfstPath = resolveCfstPath(args.cfst);
const agentId = loadAgentId();
let current = null;
let reconnectTimer = null;

connect();

function connect() {
  const wsUrl = toWebSocketUrl(server, token);
  const socket = new WebSocket(wsUrl);

  socket.on('open', () => {
    socket.send(JSON.stringify({
      type: 'hello',
      id: agentId,
      name,
      platform: process.platform,
      arch: process.arch,
      version: '0.1.0'
    }));
    logLocal(`connected to ${server} as ${name}`);
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'speedtest:start') {
      runSpeedtest(socket, message.jobId, message.params || {});
    }
    if (message.type === 'speedtest:cancel' && current?.jobId === message.jobId) {
      current.child.kill('SIGTERM');
    }
  });

  socket.on('close', () => {
    logLocal('server disconnected');
    if (current) current.child.kill('SIGTERM');
    scheduleReconnect();
  });

  socket.on('error', (error) => {
    logLocal(`websocket error: ${error.message}`);
  });
}

function runSpeedtest(socket, jobId, inputParams) {
  if (current) {
    send(socket, { type: 'job:error', jobId, error: `agent is busy with ${current.jobId}` });
    return;
  }

  if (!fs.existsSync(cfstPath)) {
    send(socket, {
      type: 'job:error',
      jobId,
      error: `找不到 CloudflareSpeedTest：${cfstPath}。请先运行 npm run cfst:install，或用 --cfst 指定路径。`
    });
    return;
  }

  const params = normalizeCfstParams(inputParams);
  const workDir = path.join(projectRoot, 'data', 'agent-jobs', jobId);
  fs.mkdirSync(workDir, { recursive: true });
  const outputPath = path.join(workDir, 'result.csv');
  const ipFilePath = defaultIpFileFor(cfstPath, params.ipVersion);
  const commandArgs = buildCfstArgs(params, {
    outputPath,
    ipFilePath: fs.existsSync(ipFilePath) ? ipFilePath : undefined
  });

  send(socket, { type: 'job:log', jobId, level: 'info', message: `${cfstPath} ${commandArgs.join(' ')}` });
  const child = spawn(cfstPath, commandArgs, { cwd: path.dirname(cfstPath) });
  current = { jobId, child };

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      send(socket, { type: 'job:log', jobId, level: 'info', message: line });
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      send(socket, { type: 'job:log', jobId, level: 'error', message: line });
    }
  });
  child.on('error', (error) => {
    current = null;
    send(socket, { type: 'job:error', jobId, error: error.message });
  });
  child.on('close', (code, signal) => {
    current = null;
    const csv = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    send(socket, {
      type: 'job:complete',
      jobId,
      exitCode: signal ? 130 : code,
      error: signal ? `killed by ${signal}` : '',
      csv
    });
  });
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function resolveCfstPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.CFST_PATH) return path.resolve(process.env.CFST_PATH);
  const binaryName = process.platform === 'win32' ? 'cfst.exe' : 'cfst';
  return path.join(projectRoot, 'vendor', 'cfst', 'current', binaryName);
}

function loadAgentId() {
  const filePath = path.join(projectRoot, 'data', 'agent-id');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8').trim();
  const id = crypto.randomUUID();
  fs.writeFileSync(filePath, id);
  return id;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1]?.startsWith('--') ? 'true' : argv[i + 1];
    out[name] = value ?? 'true';
    if (value !== 'true') i += 1;
  }
  return out;
}

function requireArg(value, name) {
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
}

function toWebSocketUrl(serverUrl, agentToken) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/agents/connect';
  url.searchParams.set('token', agentToken);
  return url.toString();
}

function logLocal(message) {
  console.log(`[agent] ${message}`);
}
