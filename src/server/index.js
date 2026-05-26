import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { loadConfig } from './config.js';
import { requireAdmin, requireAgentToken } from './auth.js';
import { openDatabase } from './db.js';
import { assertFetchableSubscriptionUrl, fetchTextWithLimit } from './security.js';
import { normalizeCfstParams, parseCfstCsv, formatPreferredAddress } from '../shared/cfst.js';
import { buildSubscriptionOutputs } from '../shared/subscription.js';

const config = loadConfig();
const store = openDatabase(config);
const fastify = Fastify({ logger: true });
const adminAuth = requireAdmin(config);
const connectedAgents = new Map();
const sseClients = new Map();

await fastify.register(fastifyWebsocket);

fastify.get('/api/agents/connect', { websocket: true }, (socket, request) => {
  if (!requireAgentToken(config, request)) {
    socket.close(1008, 'unauthorized');
    return;
  }

  let agentId = '';
  let busyJobId = null;
  const send = (message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'hello') {
      agentId = message.id || crypto.randomUUID();
      const agent = {
        id: agentId,
        name: message.name || `${message.platform || 'device'}-${agentId.slice(0, 6)}`,
        platform: message.platform || 'unknown',
        arch: message.arch || 'unknown',
        version: message.version || '',
        status: 'online'
      };
      connectedAgents.set(agentId, {
        ...agent,
        socket,
        send,
        get busyJobId() {
          return busyJobId;
        },
        set busyJobId(value) {
          busyJobId = value;
        }
      });
      store.upsertAgent(agent);
      send({ type: 'hello:ack', id: agentId });
      return;
    }

    if (!agentId) return;
    store.markAgentStatus(agentId, 'online');

    if (message.type === 'job:log') {
      store.addLog(message.jobId, message.level || 'info', message.message || '');
      emitJobEvent(message.jobId, { type: 'log', level: message.level || 'info', message: message.message || '' });
      return;
    }

    if (message.type === 'job:complete') {
      busyJobId = null;
      const job = store.getJob(message.jobId);
      const params = job?.params || {};
      const results = parseCfstCsv(message.csv || '').map((result) => ({
        ...result,
        preferredAddress: formatPreferredAddress(result, params.port)
      }));
      store.replaceResults(message.jobId, results);
      store.updateJob(message.jobId, {
        status: message.exitCode === 0 ? 'completed' : 'failed',
        output_csv: message.csv || '',
        error: message.exitCode === 0 ? null : message.error || `CFST exit ${message.exitCode}`,
        ended_at: new Date().toISOString()
      });
      emitJobEvent(message.jobId, { type: 'complete', status: message.exitCode === 0 ? 'completed' : 'failed', results });
      return;
    }

    if (message.type === 'job:error') {
      busyJobId = null;
      store.addLog(message.jobId, 'error', message.error || 'agent error');
      store.updateJob(message.jobId, {
        status: 'failed',
        error: message.error || 'agent error',
        ended_at: new Date().toISOString()
      });
      emitJobEvent(message.jobId, { type: 'error', message: message.error || 'agent error' });
    }
  });

  socket.on('close', () => {
    if (!agentId) return;
    const agent = connectedAgents.get(agentId);
    if (agent?.busyJobId) {
      store.updateJob(agent.busyJobId, {
        status: 'failed',
        error: 'agent disconnected',
        ended_at: new Date().toISOString()
      });
      emitJobEvent(agent.busyJobId, { type: 'error', message: 'agent disconnected' });
    }
    connectedAgents.delete(agentId);
    store.markAgentStatus(agentId, 'offline');
  });
});

fastify.get('/api/me', { preHandler: adminAuth }, async (request) => {
  const baseUrl = publicBaseUrl(request);
  return {
    baseUrl,
    appTokenSet: true,
    agentToken: config.agentToken,
    agentCommand: agentCommandFor(baseUrl)
  };
});

fastify.get('/api/agents', { preHandler: adminAuth }, async () => {
  const persisted = store.listAgents();
  return persisted.map((agent) => ({
    ...agent,
    status: connectedAgents.has(agent.id) ? 'online' : agent.status,
    busyJobId: connectedAgents.get(agent.id)?.busyJobId || null
  }));
});

fastify.get('/api/history', { preHandler: adminAuth }, async () => ({
  jobs: store.listJobs(20),
  subscriptions: store.listSubscriptions(20)
}));

fastify.post('/api/agents/:id/speedtests', { preHandler: adminAuth }, async (request, reply) => {
  const agent = connectedAgents.get(request.params.id);
  if (!agent) return reply.code(404).send({ error: 'agent offline' });
  if (agent.busyJobId) return reply.code(409).send({ error: 'agent already running a job', jobId: agent.busyJobId });

  const params = normalizeCfstParams(request.body?.params || {});
  const jobId = crypto.randomUUID();
  const job = store.createJob({ id: jobId, agentId: agent.id, params });
  agent.busyJobId = jobId;
  store.updateJob(jobId, { status: 'running', started_at: new Date().toISOString() });
  store.addLog(jobId, 'info', `任务已下发到 ${agent.name}`);
  agent.send({ type: 'speedtest:start', jobId, params });
  emitJobEvent(jobId, { type: 'status', status: 'running' });
  return { ...job, status: 'running' };
});

fastify.delete('/api/speedtests/:id', { preHandler: adminAuth }, async (request, reply) => {
  const job = store.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'job not found' });
  const agent = connectedAgents.get(job.agent_id);
  if (agent) agent.send({ type: 'speedtest:cancel', jobId: job.id });
  store.updateJob(job.id, { status: 'cancelled', ended_at: new Date().toISOString() });
  emitJobEvent(job.id, { type: 'status', status: 'cancelled' });
  return { ok: true };
});

fastify.get('/api/speedtests/:id', { preHandler: adminAuth }, async (request, reply) => {
  const job = store.getJobWithDetails(request.params.id);
  if (!job) return reply.code(404).send({ error: 'job not found' });
  return job;
});

fastify.get('/api/speedtests/:id/events', async (request, reply) => {
  if (request.query?.token !== config.appToken) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const job = store.getJobWithDetails(request.params.id);
  if (!job) return reply.code(404).send({ error: 'job not found' });

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  reply.raw.write(`data: ${JSON.stringify({ type: 'snapshot', job })}\n\n`);
  addSseClient(job.id, reply.raw);
  request.raw.on('close', () => removeSseClient(job.id, reply.raw));
});

fastify.post('/api/subscriptions', { preHandler: adminAuth }, async (request, reply) => {
  try {
    const body = request.body || {};
    let nodeText = String(body.nodeText || '');
    if (body.subscriptionUrl) {
      const url = await assertFetchableSubscriptionUrl(body.subscriptionUrl);
      nodeText = `${nodeText}\n${await fetchTextWithLimit(url)}`;
    }

    const preferredAddresses = resolvePreferredAddresses(body);
    const outputs = buildSubscriptionOutputs({
      nodeText,
      preferredAddresses,
      keepOriginalHost: body.keepOriginalHost !== false,
      namePrefix: body.namePrefix || 'CF'
    });

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(18).toString('hex');
    const sub = store.createSubscription({
      id,
      token,
      nodeInputSummary: summarizeNodeInput(nodeText, body.subscriptionUrl),
      preferredAddresses,
      keepOriginalHost: body.keepOriginalHost !== false,
      namePrefix: body.namePrefix || 'CF',
      raw: outputs.raw,
      clash: outputs.clash,
      surge: outputs.surge,
      v2rayn: outputs.v2rayn,
      expiresAt: expiresAtFromHours(body.expiresInHours)
    });

    const baseUrl = publicBaseUrl(request);
    return {
      id,
      nodeCount: outputs.nodes.length,
      urls: {
        raw: `${baseUrl}/sub/${id}?target=raw&token=${token}`,
        clash: `${baseUrl}/sub/${id}?target=clash&token=${token}`,
        surge: `${baseUrl}/sub/${id}?target=surge&token=${token}`,
        v2rayn: `${baseUrl}/sub/${id}?target=v2rayn&token=${token}`
      },
      expiresAt: sub.expires_at,
      subscription: sub
    };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});

fastify.get('/sub/:id', async (request, reply) => {
  const sub = store.getSubscription(request.params.id);
  if (!sub || request.query?.token !== sub.token) {
    return reply.code(404).send('not found');
  }
  if (sub.expires_at && Date.parse(sub.expires_at) <= Date.now()) {
    return reply.code(410).send('subscription expired');
  }
  const target = ['raw', 'clash', 'surge', 'v2rayn'].includes(request.query?.target) ? request.query.target : 'raw';
  const output = target === 'raw' ? sub.raw_output : target === 'clash' ? sub.clash_output : target === 'surge' ? sub.surge_output : sub.v2rayn_output;
  const contentType = target === 'clash' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8';
  return reply.header('Content-Type', contentType).send(output);
});

const clientDist = path.join(config.projectRoot, 'dist/client');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  await fastify.register(fastifyStatic, {
    root: clientDist
  });
  fastify.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api/') || request.raw.url?.startsWith('/sub/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  fastify.get('/', async (_, reply) => reply.type('text/plain').send('前端尚未构建，请运行 npm run build。'));
}

try {
  await fastify.listen({ host: config.host, port: config.port });
  fastify.log.info(`管理 token: ${config.appToken}`);
  fastify.log.info(`Agent token: ${config.agentToken}`);
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}

function resolvePreferredAddresses(body) {
  if (Array.isArray(body.preferredAddresses) && body.preferredAddresses.length > 0) {
    return body.preferredAddresses;
  }
  if (body.speedtestId) {
    const job = store.getJobWithDetails(body.speedtestId);
    if (!job) throw new Error('测速任务不存在');
    return job.results.map((result) => result.preferred_address || result.ip).filter(Boolean);
  }
  return [];
}

function summarizeNodeInput(nodeText, subscriptionUrl) {
  const nodeLines = String(nodeText || '').split(/\r?\n/).filter((line) => line.trim()).length;
  if (subscriptionUrl) return `URL: ${subscriptionUrl}; pasted lines: ${nodeLines}`;
  return `pasted lines: ${nodeLines}`;
}

function expiresAtFromHours(value) {
  const hours = Number.parseInt(value ?? '24', 10);
  const normalized = Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 24;
  return new Date(Date.now() + normalized * 60 * 60 * 1000).toISOString();
}

function addSseClient(jobId, response) {
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(response);
}

function removeSseClient(jobId, response) {
  const clients = sseClients.get(jobId);
  if (!clients) return;
  clients.delete(response);
  if (clients.size === 0) sseClients.delete(jobId);
}

function emitJobEvent(jobId, event) {
  const clients = sseClients.get(jobId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(data);
}

function publicBaseUrl(request) {
  const proto = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers['x-forwarded-host'] || request.headers.host || `127.0.0.1:${config.port}`;
  return `${proto}://${host}`;
}

function agentCommandFor(baseUrl) {
  return `npm run cfst:install && npm run agent -- --server ${baseUrl} --token ${config.agentToken} --name <设备名>`;
}
