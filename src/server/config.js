import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
const secretsPath = path.join(dataDir, 'secrets.json');

export function loadConfig() {
  fs.mkdirSync(dataDir, { recursive: true });
  const secrets = loadOrCreateSecrets();
  return {
    projectRoot,
    dataDir,
    host: process.env.APP_HOST || '0.0.0.0',
    port: Number.parseInt(process.env.APP_PORT || '8787', 10),
    appToken: process.env.APP_TOKEN || secrets.appToken,
    agentToken: process.env.AGENT_TOKEN || secrets.agentToken,
    cfstVersion: process.env.CFST_VERSION || 'v2.3.5'
  };
}

function loadOrCreateSecrets() {
  if (fs.existsSync(secretsPath)) {
    return JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  }
  const secrets = {
    appToken: crypto.randomBytes(24).toString('hex'),
    agentToken: crypto.randomBytes(24).toString('hex')
  };
  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
  fs.chmodSync(secretsPath, 0o600);
  return secrets;
}
