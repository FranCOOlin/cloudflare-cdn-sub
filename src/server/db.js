import path from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(config) {
  const db = new Database(path.join(config.dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return createStore(db);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      arch TEXT NOT NULL,
      version TEXT,
      status TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speedtest_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL,
      output_csv TEXT,
      error TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS speedtest_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES speedtest_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS speedtest_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      rank INTEGER,
      ip TEXT NOT NULL,
      sent INTEGER,
      received INTEGER,
      loss_rate TEXT,
      loss_rate_percent REAL,
      latency_ms REAL,
      download_speed_mbps REAL,
      colo TEXT,
      preferred_address TEXT,
      FOREIGN KEY(job_id) REFERENCES speedtest_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      node_input_summary TEXT,
      preferred_addresses_json TEXT NOT NULL,
      keep_original_host INTEGER NOT NULL,
      name_prefix TEXT NOT NULL,
      raw_output TEXT NOT NULL,
      clash_output TEXT NOT NULL,
      surge_output TEXT NOT NULL,
      v2rayn_output TEXT NOT NULL DEFAULT '',
      expires_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'subscriptions', 'v2rayn_output', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'subscriptions', 'expires_at', 'TEXT');
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function createStore(db) {
  const now = () => new Date().toISOString();
  return {
    db,
    upsertAgent(agent) {
      const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent.id);
      const timestamp = now();
      if (existing) {
        db.prepare(`
          UPDATE agents SET name = ?, platform = ?, arch = ?, version = ?, status = ?, last_seen = ?
          WHERE id = ?
        `).run(agent.name, agent.platform, agent.arch, agent.version || '', agent.status, timestamp, agent.id);
      } else {
        db.prepare(`
          INSERT INTO agents (id, name, platform, arch, version, status, last_seen, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(agent.id, agent.name, agent.platform, agent.arch, agent.version || '', agent.status, timestamp, timestamp);
      }
    },
    markAgentStatus(id, status) {
      db.prepare('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?').run(status, now(), id);
    },
    listAgents() {
      return db.prepare('SELECT * FROM agents ORDER BY last_seen DESC').all();
    },
    createJob(job) {
      const timestamp = now();
      db.prepare(`
        INSERT INTO speedtest_jobs (id, agent_id, params_json, status, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(job.id, job.agentId, JSON.stringify(job.params), 'queued', timestamp);
      return this.getJob(job.id);
    },
    updateJob(id, patch) {
      const current = this.getJob(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      db.prepare(`
        UPDATE speedtest_jobs
        SET status = ?, output_csv = ?, error = ?, started_at = ?, ended_at = ?
        WHERE id = ?
      `).run(next.status, next.output_csv || next.outputCsv || null, next.error || null, next.started_at || next.startedAt || null, next.ended_at || next.endedAt || null, id);
      return this.getJob(id);
    },
    addLog(jobId, level, message) {
      db.prepare(`
        INSERT INTO speedtest_logs (job_id, level, message, created_at)
        VALUES (?, ?, ?, ?)
      `).run(jobId, level, String(message).slice(0, 4000), now());
    },
    replaceResults(jobId, results) {
      const insert = db.prepare(`
        INSERT INTO speedtest_results (
          job_id, rank, ip, sent, received, loss_rate, loss_rate_percent,
          latency_ms, download_speed_mbps, colo, preferred_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM speedtest_results WHERE job_id = ?').run(jobId);
        for (const result of results) {
          insert.run(
            jobId,
            result.rank,
            result.ip,
            result.sent,
            result.received,
            result.lossRate,
            result.lossRatePercent,
            result.latencyMs,
            result.downloadSpeedMBps,
            result.colo,
            result.preferredAddress || result.ip
          );
        }
      });
      tx();
    },
    getJob(id) {
      const job = db.prepare('SELECT * FROM speedtest_jobs WHERE id = ?').get(id);
      if (!job) return null;
      return {
        ...job,
        params: JSON.parse(job.params_json)
      };
    },
    getJobWithDetails(id) {
      const job = this.getJob(id);
      if (!job) return null;
      return {
        ...job,
        logs: db.prepare('SELECT * FROM speedtest_logs WHERE job_id = ? ORDER BY id ASC').all(id),
        results: db.prepare('SELECT * FROM speedtest_results WHERE job_id = ? ORDER BY download_speed_mbps DESC, latency_ms ASC').all(id)
      };
    },
    listJobs(limit = 20) {
      return db.prepare(`
        SELECT j.*, a.name AS agent_name
        FROM speedtest_jobs j
        LEFT JOIN agents a ON a.id = j.agent_id
        ORDER BY j.created_at DESC
        LIMIT ?
      `).all(limit).map((job) => ({ ...job, params: JSON.parse(job.params_json) }));
    },
    createSubscription(subscription) {
      db.prepare(`
        INSERT INTO subscriptions (
          id, token, node_input_summary, preferred_addresses_json, keep_original_host,
          name_prefix, raw_output, clash_output, surge_output, v2rayn_output, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        subscription.id,
        subscription.token,
        subscription.nodeInputSummary,
        JSON.stringify(subscription.preferredAddresses),
        subscription.keepOriginalHost ? 1 : 0,
        subscription.namePrefix,
        subscription.raw,
        subscription.clash,
        subscription.surge,
        subscription.v2rayn,
        subscription.expiresAt,
        now()
      );
      return this.getSubscription(subscription.id);
    },
    getSubscription(id) {
      const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
      if (!sub) return null;
      return {
        ...sub,
        preferredAddresses: JSON.parse(sub.preferred_addresses_json),
        keepOriginalHost: Boolean(sub.keep_original_host)
      };
    },
    listSubscriptions(limit = 20) {
      return db.prepare('SELECT id, node_input_summary, preferred_addresses_json, keep_original_host, name_prefix, expires_at, created_at FROM subscriptions ORDER BY created_at DESC LIMIT ?')
        .all(limit)
        .map((sub) => ({
          ...sub,
          preferredAddresses: JSON.parse(sub.preferred_addresses_json),
          keepOriginalHost: Boolean(sub.keep_original_host)
        }));
    }
  };
}
