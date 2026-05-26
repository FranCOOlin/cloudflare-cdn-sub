import path from 'node:path';

export const DEFAULT_CFST_PARAMS = Object.freeze({
  ipVersion: 'ipv4',
  count: 100,
  concurrency: 4,
  downloadCount: 10,
  downloadSeconds: 10,
  port: 443,
  printCount: 0,
  testUrl: ''
});

const INTEGER_LIMITS = {
  count: [1, 100000],
  concurrency: [1, 1000],
  downloadCount: [0, 1000],
  downloadSeconds: [1, 3600],
  port: [1, 65535],
  printCount: [0, 100000]
};

export function normalizeCfstParams(input = {}) {
  const params = { ...DEFAULT_CFST_PARAMS, ...input };
  params.ipVersion = params.ipVersion === 'ipv6' ? 'ipv6' : 'ipv4';
  for (const [key, [min, max]] of Object.entries(INTEGER_LIMITS)) {
    const value = Number.parseInt(params[key], 10);
    params[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_CFST_PARAMS[key];
  }
  params.testUrl = typeof params.testUrl === 'string' ? params.testUrl.trim() : '';
  return params;
}

export function buildCfstArgs(input = {}, options = {}) {
  const params = normalizeCfstParams(input);
  const args = [
    '-n', String(params.count),
    '-t', String(params.concurrency),
    '-dn', String(params.downloadCount),
    '-dt', String(params.downloadSeconds),
    '-tp', String(params.port),
    '-p', String(params.printCount)
  ];

  if (options.ipFilePath) args.push('-f', options.ipFilePath);
  if (params.testUrl) args.push('-url', params.testUrl);
  if (options.outputPath) args.push('-o', options.outputPath);
  return args;
}

export function defaultIpFileFor(cfstPath, ipVersion = 'ipv4') {
  const fileName = ipVersion === 'ipv6' ? 'ipv6.txt' : 'ip.txt';
  return path.join(path.dirname(cfstPath), fileName);
}

export function parseCfstCsv(csvText) {
  const records = parseCsv(csvText);
  if (records.length < 2) return [];

  const headers = records[0].map((value) => value.trim());
  return records.slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row, index) => rowToResult(headers, row, index))
    .filter((result) => result.ip);
}

export function formatPreferredAddress(result, fallbackPort = 443) {
  const ip = typeof result === 'string' ? result : result.ip;
  const port = typeof result === 'object' && result.port ? Number(result.port) : Number(fallbackPort);
  if (!ip) return '';
  const host = ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
  return port && port !== 443 ? `${host}:${port}` : host;
}

function rowToResult(headers, row, index) {
  const get = (...needles) => {
    const headerIndex = headers.findIndex((header) => needles.some((needle) => header.toLowerCase().includes(needle.toLowerCase())));
    return headerIndex >= 0 ? row[headerIndex]?.trim() ?? '' : '';
  };

  const ip = get('IP 地址', 'IP Address', 'IP');
  const latencyRaw = get('平均延迟', 'Latency', '延迟');
  const speedRaw = get('下载速度', 'Download Speed', '速度');
  const lossRaw = get('丢包率', 'Loss');
  const sentRaw = get('已发送', 'Sent');
  const receivedRaw = get('已接收', 'Received');
  const colo = get('数据中心', '地区码', 'Colo', 'colo', '区域');

  return {
    rank: index + 1,
    ip,
    sent: toNumber(sentRaw),
    received: toNumber(receivedRaw),
    lossRate: lossRaw,
    lossRatePercent: toNumber(lossRaw),
    latencyMs: toNumber(latencyRaw),
    downloadSpeedMBps: toNumber(speedRaw),
    colo
  };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < String(text).length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function toNumber(value) {
  const normalized = String(value ?? '').replace('%', '').replace(/ms|MB\/s|Mbit\/s|Mbps/gi, '').trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
