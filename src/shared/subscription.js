import YAML from 'yaml';

export function buildSubscriptionOutputs({ nodeText, preferredAddresses, keepOriginalHost = true, namePrefix = 'CF' }) {
  const baseNodes = parseNodeText(nodeText);
  if (baseNodes.length === 0) {
    throw new Error('没有识别到 vmess/vless/trojan 节点');
  }

  const targets = normalizePreferredAddresses(preferredAddresses);
  if (targets.length === 0) {
    throw new Error('至少需要一个优选 IP 或域名');
  }

  const expanded = [];
  for (const node of baseNodes) {
    for (const target of targets) {
      expanded.push(applyPreferredAddress(node, target, { keepOriginalHost, namePrefix }));
    }
  }

  return {
    nodes: expanded,
    raw: renderRaw(expanded),
    clash: renderClash(expanded),
    surge: renderSurge(expanded),
    v2rayn: renderV2rayN(expanded)
  };
}

export function parseNodeText(input) {
  const lines = expandPossibleBase64(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const nodes = [];
  for (const line of lines) {
    try {
      if (line.startsWith('vmess://')) nodes.push(parseVmess(line));
      if (line.startsWith('vless://')) nodes.push(parseUrlNode(line, 'vless'));
      if (line.startsWith('trojan://')) nodes.push(parseUrlNode(line, 'trojan'));
    } catch {
      // Ignore malformed lines and keep parsing the rest of the subscription.
    }
  }
  return nodes;
}

export function normalizePreferredAddresses(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n|,/);
  return lines
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .map(parsePreferredAddress);
}

function parsePreferredAddress(value) {
  const hashIndex = value.indexOf('#');
  const address = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const remark = hashIndex >= 0 ? decodeURIComponent(value.slice(hashIndex + 1)) : '';

  if (address.startsWith('[')) {
    const end = address.indexOf(']');
    const host = address.slice(1, end);
    const portText = address.slice(end + 1).replace(/^:/, '');
    return { host, port: toPort(portText), remark };
  }

  const colonCount = (address.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [host, portText] = address.split(':');
    return { host, port: toPort(portText), remark };
  }
  return { host: address, port: null, remark };
}

function applyPreferredAddress(node, target, options) {
  if (node.type === 'vmess') return applyVmess(node, target, options);
  return applyUrlNode(node, target, options);
}

function applyVmess(node, target, { keepOriginalHost, namePrefix }) {
  const original = node.raw;
  const copy = { ...original };
  const oldHost = original.add;
  copy.add = target.host;
  if (target.port) copy.port = String(target.port);
  if (keepOriginalHost) {
    if (!copy.sni && oldHost) copy.sni = oldHost;
    if (!copy.host && oldHost) copy.host = oldHost;
  }
  copy.ps = buildName(namePrefix, original.ps || oldHost || 'vmess', target);
  return { type: 'vmess', raw: copy, name: copy.ps };
}

function applyUrlNode(node, target, { keepOriginalHost, namePrefix }) {
  const next = new URL(node.url.toString());
  const oldHost = next.hostname;
  next.hostname = target.host;
  if (target.port) next.port = String(target.port);
  if (keepOriginalHost && oldHost) {
    if (!next.searchParams.get('sni')) next.searchParams.set('sni', oldHost);
    if (!next.searchParams.get('host')) next.searchParams.set('host', oldHost);
  }
  next.hash = encodeURIComponent(buildName(namePrefix, node.name || oldHost || node.type, target));
  return { type: node.type, url: next, name: decodeURIComponent(next.hash.slice(1)) };
}

function parseVmess(line) {
  const payload = line.slice('vmess://'.length);
  const raw = JSON.parse(decodeBase64(payload));
  return {
    type: 'vmess',
    raw,
    name: raw.ps || raw.add || 'vmess'
  };
}

function parseUrlNode(line, type) {
  const url = new URL(line);
  return {
    type,
    url,
    name: decodeURIComponent(url.hash.slice(1)) || url.hostname || type
  };
}

function renderRaw(nodes) {
  return nodes.map((node) => {
    if (node.type === 'vmess') {
      return `vmess://${encodeBase64(JSON.stringify(node.raw))}`;
    }
    return node.url.toString();
  }).join('\n');
}

function renderV2rayN(nodes) {
  return encodeBase64(renderRaw(nodes));
}

function renderClash(nodes) {
  const proxies = nodes.map(toClashProxy).filter(Boolean);
  return YAML.stringify({
    port: 7890,
    'socks-port': 7891,
    'allow-lan': true,
    mode: 'rule',
    proxies,
    'proxy-groups': [
      {
        name: 'CF 优选',
        type: 'select',
        proxies: proxies.map((proxy) => proxy.name)
      }
    ],
    rules: ['MATCH,CF 优选']
  });
}

function toClashProxy(node) {
  if (node.type === 'vmess') {
    const raw = node.raw;
    const proxy = {
      name: node.name,
      type: 'vmess',
      server: raw.add,
      port: Number(raw.port || 443),
      uuid: raw.id,
      alterId: Number(raw.aid || 0),
      cipher: raw.scy || 'auto',
      udp: true,
      tls: raw.tls === 'tls'
    };
    if (raw.sni) proxy.servername = raw.sni;
    if (raw.net) proxy.network = raw.net;
    if (raw.net === 'ws') {
      proxy['ws-opts'] = { path: raw.path || '/', headers: {} };
      if (raw.host) proxy['ws-opts'].headers.Host = raw.host;
    }
    return proxy;
  }

  const url = node.url;
  const params = url.searchParams;
  const proxy = {
    name: node.name,
    type: node.type,
    server: url.hostname,
    port: Number(url.port || 443),
    udp: true
  };
  if (node.type === 'trojan') proxy.password = decodeURIComponent(url.username);
  if (node.type === 'vless') proxy.uuid = decodeURIComponent(url.username);
  if (params.get('security') === 'tls' || params.get('sni') || params.get('tls') === '1') proxy.tls = true;
  if (params.get('sni')) proxy.servername = params.get('sni');
  if (params.get('fp')) proxy['client-fingerprint'] = params.get('fp');
  if (params.get('flow')) proxy.flow = params.get('flow');
  const network = params.get('type') || params.get('network');
  if (network) proxy.network = network;
  if (network === 'ws') {
    proxy['ws-opts'] = { path: params.get('path') || '/', headers: {} };
    if (params.get('host')) proxy['ws-opts'].headers.Host = params.get('host');
  }
  return proxy;
}

function renderSurge(nodes) {
  return [
    '[Proxy]',
    ...nodes.map(toSurgeLine).filter(Boolean),
    '',
    '[Proxy Group]',
    `CF 优选 = select, ${nodes.map((node) => node.name).join(', ')}`,
    '',
    '[Rule]',
    'FINAL,CF 优选'
  ].join('\n');
}

function toSurgeLine(node) {
  if (node.type === 'vmess') {
    const raw = node.raw;
    const parts = [
      `${node.name} = vmess`,
      `${raw.add}`,
      `${raw.port || 443}`,
      `username=${raw.id}`,
      `tls=${raw.tls === 'tls' ? 'true' : 'false'}`,
      `vmess-aead=true`
    ];
    if (raw.sni) parts.push(`sni=${raw.sni}`);
    if (raw.net === 'ws') {
      parts.push('ws=true');
      parts.push(`ws-path=${raw.path || '/'}`);
      if (raw.host) parts.push(`ws-headers=Host:${raw.host}`);
    }
    return parts.join(', ');
  }

  const url = node.url;
  const params = url.searchParams;
  const parts = [
    `${node.name} = ${node.type}`,
    url.hostname,
    url.port || '443'
  ];
  if (node.type === 'trojan') parts.push(`password=${decodeURIComponent(url.username)}`);
  if (node.type === 'vless') parts.push(`username=${decodeURIComponent(url.username)}`);
  parts.push(`tls=${params.get('security') === 'tls' || params.get('sni') ? 'true' : 'false'}`);
  if (params.get('sni')) parts.push(`sni=${params.get('sni')}`);
  if ((params.get('type') || params.get('network')) === 'ws') {
    parts.push('ws=true');
    parts.push(`ws-path=${params.get('path') || '/'}`);
    if (params.get('host')) parts.push(`ws-headers=Host:${params.get('host')}`);
  }
  return parts.join(', ');
}

function expandPossibleBase64(input) {
  const text = String(input ?? '').trim();
  if (!text || text.includes('://')) return text;
  try {
    const decoded = decodeBase64(text);
    if (decoded.includes('://')) return decoded;
  } catch {
    // Plain text input.
  }
  return text;
}

function buildName(prefix, base, target) {
  const label = target.remark || target.host;
  return `${prefix}-${label}-${base}`.replace(/\s+/g, '-');
}

function encodeBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeBase64(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function toPort(value) {
  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
}
