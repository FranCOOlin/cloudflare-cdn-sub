import dns from 'node:dns/promises';
import net from 'node:net';

export async function assertFetchableSubscriptionUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('订阅 URL 格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('订阅 URL 只允许 http/https');
  }
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error('出于安全考虑，订阅 URL 不能指向内网地址');
  }
  return url;
}

export async function fetchTextWithLimit(url, { timeoutMs = 10000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`订阅下载失败：HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error('订阅内容超过 2MB 限制');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isPrivateAddress(address) {
  if (address === '127.0.0.1' || address === '::1') return true;
  if (address.startsWith('10.')) return true;
  if (address.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return true;
  if (address.startsWith('169.254.')) return true;
  if (address.toLowerCase().startsWith('fc') || address.toLowerCase().startsWith('fd')) return true;
  if (address.toLowerCase().startsWith('fe80:')) return true;
  return false;
}
