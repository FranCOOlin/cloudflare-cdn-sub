import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Clock,
  Copy,
  Database,
  Download,
  History,
  Link,
  Monitor,
  Play,
  RefreshCw,
  Router,
  Server,
  Shield,
  Smartphone,
  Square,
  Wifi
} from 'lucide-react';
import './styles.css';

const DEFAULT_PARAMS = {
  ipVersion: 'ipv4',
  count: 100,
  concurrency: 4,
  downloadCount: 10,
  downloadSeconds: 10,
  port: 443,
  printCount: 0,
  testUrl: ''
};

const TABS = [
  { id: 'browser', label: '无Agent测速', icon: Wifi },
  { id: 'agent', label: 'Agent优选IP', icon: Server },
  { id: 'subscription', label: '临时订阅', icon: Link },
  { id: 'tutorials', label: '使用教程', icon: Monitor },
  { id: 'history', label: '历史记录', icon: History }
];

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('appToken') || '');
  const [tokenInput, setTokenInput] = useState(token);
  const [activeTab, setActiveTab] = useState('browser');
  const [me, setMe] = useState(null);
  const [agents, setAgents] = useState([]);
  const [history, setHistory] = useState({ jobs: [], subscriptions: [] });
  const [selectedAgent, setSelectedAgent] = useState('');
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [selectedResults, setSelectedResults] = useState(new Set());
  const [nodeText, setNodeText] = useState('');
  const [subscriptionUrl, setSubscriptionUrl] = useState('');
  const [manualPreferred, setManualPreferred] = useState('');
  const [namePrefix, setNamePrefix] = useState('CF');
  const [keepOriginalHost, setKeepOriginalHost] = useState(true);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [subscription, setSubscription] = useState(null);
  const [message, setMessage] = useState('');
  const [browserTest, setBrowserTest] = useState({ status: 'idle' });
  const eventSource = useRef(null);
  const isIos = useMemo(() => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1), []);

  useEffect(() => {
    if (!token) return;
    localStorage.setItem('appToken', token);
    refreshAll();
    const timer = setInterval(() => loadAgents().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [token]);

  useEffect(() => {
    if (!selectedAgent && agents.length > 0) {
      const online = agents.find((agent) => agent.status === 'online') || agents[0];
      setSelectedAgent(online.id);
    }
  }, [agents, selectedAgent]);

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function refreshAll() {
    try {
      const [meData] = await Promise.all([api('/api/me'), loadAgents(), loadHistory()]);
      setMe(meData);
      setMessage('');
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function loadAgents() {
    const data = await api('/api/agents');
    setAgents(data);
    return data;
  }

  async function loadHistory() {
    const data = await api('/api/history');
    setHistory(data);
    return data;
  }

  async function startSpeedtest() {
    if (!selectedAgent) {
      setMessage('请选择在线 agent');
      return;
    }
    try {
      const started = await api(`/api/agents/${selectedAgent}/speedtests`, {
        method: 'POST',
        body: JSON.stringify({ params })
      });
      setJob({ ...started, results: [] });
      setLogs([]);
      setSelectedResults(new Set());
      subscribeJob(started.id);
      await loadAgents();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function cancelSpeedtest() {
    if (!job) return;
    await api(`/api/speedtests/${job.id}`, { method: 'DELETE' });
    setJob({ ...job, status: 'cancelled' });
  }

  async function openJob(jobId) {
    try {
      const data = await api(`/api/speedtests/${jobId}`);
      setJob(data);
      setLogs(data.logs || []);
      setSelectedResults(new Set((data.results || []).slice(0, 3).map((row) => row.id)));
      setActiveTab('agent');
      subscribeJob(jobId);
    } catch (error) {
      setMessage(error.message);
    }
  }

  function subscribeJob(jobId) {
    if (eventSource.current) eventSource.current.close();
    const source = new EventSource(`/api/speedtests/${jobId}/events?token=${encodeURIComponent(token)}`);
    eventSource.current = source;
    source.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        setJob(data.job);
        setLogs(data.job.logs || []);
        setSelectedResults(new Set((data.job.results || []).slice(0, 3).map((row) => row.id)));
      }
      if (data.type === 'log') {
        setLogs((items) => [...items, { level: data.level, message: data.message, created_at: new Date().toISOString() }]);
      }
      if (data.type === 'complete' || data.type === 'error') {
        await openJob(jobId);
        await loadHistory();
        await loadAgents();
      }
      if (data.type === 'status') {
        setJob((current) => current ? { ...current, status: data.status } : current);
      }
    };
  }

  async function createSubscription() {
    const selected = selectedAddresses();
    const preferredAddresses = selected.length > 0 ? selected : manualPreferred.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
    try {
      const data = await api('/api/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          nodeText,
          subscriptionUrl,
          preferredAddresses,
          keepOriginalHost,
          namePrefix,
          expiresInHours
        })
      });
      setSubscription(data);
      await loadHistory();
      setMessage('');
    } catch (error) {
      setMessage(error.message);
    }
  }

  function selectedAddresses() {
    const rows = job?.results || [];
    return rows
      .filter((row) => selectedResults.has(row.id))
      .map((row) => row.preferred_address || row.ip);
  }

  function toggleResult(id) {
    setSelectedResults((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copy(text) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setMessage('已复制');
  }

  async function runBrowserTest() {
    setBrowserTest({ status: 'running', progress: '测量空载延迟...' });
    try {
      const latencySamples = [];
      for (let i = 0; i < 6; i += 1) {
        latencySamples.push(await measureLatency());
        setBrowserTest((current) => ({ ...current, progress: `空载延迟 ${i + 1}/6` }));
      }

      const downloadSamples = [];
      for (const bytes of [1_000_000, 5_000_000, 10_000_000]) {
        const sample = await measureDownload(bytes);
        downloadSamples.push(sample);
        setBrowserTest((current) => ({ ...current, progress: `下载 ${formatBytes(bytes)} 完成` }));
      }

      const uploadSamples = [];
      for (const bytes of [512_000, 1_000_000]) {
        try {
          const sample = await measureUpload(bytes);
          uploadSamples.push(sample);
          setBrowserTest((current) => ({ ...current, progress: `上传 ${formatBytes(bytes)} 完成` }));
        } catch (error) {
          uploadSamples.push({ bytes, error: error.message });
        }
      }

      const summary = {
        latencyMs: average(latencySamples),
        downloadMbps: average(downloadSamples.map((item) => item.mbps)),
        uploadMbps: average(uploadSamples.filter((item) => item.mbps).map((item) => item.mbps))
      };
      setBrowserTest({ status: 'done', latencySamples, downloadSamples, uploadSamples, summary });
    } catch (error) {
      setBrowserTest({ status: 'error', error: error.message });
    }
  }

  if (!token) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <Shield size={32} />
          <h1>Cloudflare CDN 设备测速订阅</h1>
          <p>输入服务端启动时打印的管理 token。</p>
          <input value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="APP_TOKEN" />
          <button onClick={() => setToken(tokenInput.trim())}><Shield size={16} />进入控制台</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Cloudflare CDN 设备测速订阅</h1>
          <p>无安装浏览器测速用于体验评估；自动优选订阅仍使用 Agent 或手填 IP。</p>
        </div>
        <div className="topbar-actions">
          <button title="刷新" onClick={refreshAll}><RefreshCw size={16} />刷新</button>
          <button title="退出" onClick={() => { localStorage.removeItem('appToken'); setToken(''); }}><Shield size={16} />退出</button>
        </div>
      </header>

      {message && <div className="notice">{message}</div>}

      <nav className="tabs" aria-label="功能分区">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>
              <Icon size={16} />{tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === 'browser' && (
        <BrowserSpeedPanel
          browserTest={browserTest}
          isIos={isIos}
          runBrowserTest={runBrowserTest}
        />
      )}

      {activeTab === 'agent' && (
        <AgentPanel
          agents={agents}
          cancelSpeedtest={cancelSpeedtest}
          copy={copy}
          job={job}
          logs={logs}
          me={me}
          params={params}
          selectedAgent={selectedAgent}
          selectedResults={selectedResults}
          setActiveTab={setActiveTab}
          setParams={setParams}
          setSelectedAgent={setSelectedAgent}
          startSpeedtest={startSpeedtest}
          toggleResult={toggleResult}
        />
      )}

      {activeTab === 'subscription' && (
        <SubscriptionPanel
          copy={copy}
          createSubscription={createSubscription}
          expiresInHours={expiresInHours}
          job={job}
          keepOriginalHost={keepOriginalHost}
          manualPreferred={manualPreferred}
          namePrefix={namePrefix}
          nodeText={nodeText}
          selectedAddresses={selectedAddresses()}
          setExpiresInHours={setExpiresInHours}
          setKeepOriginalHost={setKeepOriginalHost}
          setManualPreferred={setManualPreferred}
          setNamePrefix={setNamePrefix}
          setNodeText={setNodeText}
          setSubscriptionUrl={setSubscriptionUrl}
          subscription={subscription}
          subscriptionUrl={subscriptionUrl}
        />
      )}

      {activeTab === 'history' && (
        <HistoryPanel history={history} openJob={openJob} />
      )}

      {activeTab === 'tutorials' && (
        <TutorialsPanel
          agentToken={me?.agentToken || ''}
          baseUrl={me?.baseUrl || window.location.origin}
          copy={copy}
        />
      )}
    </main>
  );
}

function BrowserSpeedPanel({ browserTest, isIos, runBrowserTest }) {
  const summary = browserTest.summary || {};
  return (
    <div className="tab-stack">
      <section className="hero-panel browser-hero">
        <div>
          <h2>无 Agent 浏览器测速</h2>
          <p>直接从当前浏览器访问 Cloudflare Speed Test 端点，适合 iOS、临时设备和不想安装 agent 的场景。</p>
        </div>
        <button className="primary large-action" onClick={runBrowserTest} disabled={browserTest.status === 'running'}>
          <Play size={18} />{browserTest.status === 'running' ? '测速中' : '开始无 Agent 测速'}
        </button>
      </section>

      <section className="grid three metrics-grid">
        <Metric title="延迟" value={summary.latencyMs ? `${summary.latencyMs.toFixed(1)} ms` : '-'} />
        <Metric title="下载" value={summary.downloadMbps ? `${summary.downloadMbps.toFixed(2)} Mbps` : '-'} />
        <Metric title="上传" value={summary.uploadMbps ? `${summary.uploadMbps.toFixed(2)} Mbps` : '-'} />
      </section>

      <section className="grid two">
        <Panel title="测速状态" icon={<Activity size={18} />}>
          {browserTest.status === 'idle' && <div className="empty">点击开始后，会测量当前设备到 Cloudflare 网络的 HTTP 延迟、下载和上传体验。</div>}
          {browserTest.status === 'running' && <div className="notice compact">{browserTest.progress || '正在测速...'}</div>}
          {browserTest.status === 'error' && <div className="notice error">{browserTest.error}</div>}
          {browserTest.status === 'done' && (
            <div className="sample-list">
              <strong>下载样本</strong>
              {(browserTest.downloadSamples || []).map((item) => <span key={`d-${item.bytes}`}>{formatBytes(item.bytes)} · {item.mbps.toFixed(2)} Mbps · {item.seconds.toFixed(2)} 秒</span>)}
              <strong>上传样本</strong>
              {(browserTest.uploadSamples || []).map((item) => <span key={`u-${item.bytes}`}>{formatBytes(item.bytes)} · {item.error ? item.error : `${item.mbps.toFixed(2)} Mbps · ${item.seconds.toFixed(2)} 秒`}</span>)}
            </div>
          )}
        </Panel>
        <Panel title="适用边界" icon={isIos ? <Smartphone size={18} /> : <Wifi size={18} />}>
          <div className="explain-list">
            <span>无需安装，测速发生在当前浏览器所在设备，iPhone/iPad 可直接使用。</span>
            <span>它不能枚举 Cloudflare 候选 IP，也不能自动产出可替换到代理节点里的优选 IP。</span>
            <span>要生成订阅，请在“临时订阅”里手填优选 IP，或使用“Agent优选IP”的真实 CFST 结果。</span>
          </div>
        </Panel>
      </section>
    </div>
  );
}

function AgentPanel(props) {
  const {
    agents,
    cancelSpeedtest,
    copy,
    job,
    logs,
    me,
    params,
    selectedAgent,
    selectedResults,
    setActiveTab,
    setParams,
    setSelectedAgent,
    startSpeedtest,
    toggleResult
  } = props;

  return (
    <div className="tab-stack">
      <section className="grid two">
        <Panel title="Agent 连接" icon={<Server size={18} />}>
          <div className="command-row">
            <code>{me?.agentCommand || '加载中...'}</code>
            <button title="复制 agent 命令" onClick={() => copy(me?.agentCommand || '')}><Copy size={16} /></button>
          </div>
          <div className="agents">
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`agent-row ${selectedAgent === agent.id ? 'active' : ''}`}
                onClick={() => setSelectedAgent(agent.id)}
              >
                <span className={`status ${agent.status}`}></span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.platform}/{agent.arch} {agent.busyJobId ? `运行中 ${agent.busyJobId.slice(0, 8)}` : ''}</small>
                </span>
              </button>
            ))}
            {agents.length === 0 && <div className="empty">还没有 agent 连接。无安装测速请切到“无Agent测速”。</div>}
          </div>
        </Panel>

        <Panel title="CFST 配置" icon={<Router size={18} />}>
          <div className="form-grid">
            <label>IP 版本<Select value={params.ipVersion} onChange={(value) => setParams({ ...params, ipVersion: value })} options={[['ipv4', 'IPv4'], ['ipv6', 'IPv6']]} /></label>
            <label>TCP 端口<NumberInput value={params.port} onChange={(value) => setParams({ ...params, port: value })} /></label>
            <label>延迟线程<NumberInput value={params.count} onChange={(value) => setParams({ ...params, count: value })} /></label>
            <label>延迟次数<NumberInput value={params.concurrency} onChange={(value) => setParams({ ...params, concurrency: value })} /></label>
            <label>下载数量<NumberInput value={params.downloadCount} onChange={(value) => setParams({ ...params, downloadCount: value })} /></label>
            <label>下载秒数<NumberInput value={params.downloadSeconds} onChange={(value) => setParams({ ...params, downloadSeconds: value })} /></label>
          </div>
          <label className="wide-label">测速 URL<input value={params.testUrl} onChange={(event) => setParams({ ...params, testUrl: event.target.value })} placeholder="留空使用 CFST 默认下载 URL" /></label>
          <div className="action-row">
            <button className="primary" onClick={startSpeedtest}><Play size={16} />开始真实优选</button>
            <button onClick={cancelSpeedtest} disabled={!job || !['running', 'queued'].includes(job.status)}><Square size={16} />取消</button>
            <button onClick={() => setActiveTab('subscription')} disabled={!job?.results?.length}><Link size={16} />去生成订阅</button>
          </div>
        </Panel>
      </section>

      <section className="grid two uneven">
        <Panel title="优选 IP 结果" icon={<Wifi size={18} />}>
          <div className="job-meta">
            <span>任务：{job?.id ? job.id.slice(0, 8) : '未开始'}</span>
            <span>状态：{job?.status || '-'}</span>
            <span>已选：{selectedResults.size}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>IP</th>
                  <th>延迟</th>
                  <th>丢包</th>
                  <th>下载 MB/s</th>
                  <th>地区</th>
                </tr>
              </thead>
              <tbody>
                {(job?.results || []).map((row) => (
                  <tr key={row.id}>
                    <td><input type="checkbox" checked={selectedResults.has(row.id)} onChange={() => toggleResult(row.id)} /></td>
                    <td>{row.preferred_address || row.ip}</td>
                    <td>{formatNumber(row.latency_ms)} ms</td>
                    <td>{row.loss_rate || '-'}</td>
                    <td>{formatNumber(row.download_speed_mbps)}</td>
                    <td>{row.colo || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(!job?.results || job.results.length === 0) && <div className="empty">完成真实 CFST 后这里会显示可用于订阅的优选 IP。</div>}
          </div>
        </Panel>

        <Panel title="实时日志" icon={<Database size={18} />}>
          <div className="log-box">
            {logs.map((line, index) => (
              <div key={`${line.created_at}-${index}`} className={line.level === 'error' ? 'log-error' : ''}>{line.message}</div>
            ))}
            {logs.length === 0 && <span>暂无日志。</span>}
          </div>
        </Panel>
      </section>
    </div>
  );
}

function SubscriptionPanel(props) {
  const {
    copy,
    createSubscription,
    expiresInHours,
    keepOriginalHost,
    manualPreferred,
    namePrefix,
    nodeText,
    selectedAddresses,
    setExpiresInHours,
    setKeepOriginalHost,
    setManualPreferred,
    setNamePrefix,
    setNodeText,
    setSubscriptionUrl,
    subscription,
    subscriptionUrl
  } = props;

  return (
    <div className="tab-stack">
      <section className="grid two uneven reverse">
        <Panel title="输入与临时地址设置" icon={<Link size={18} />}>
          <div className="form-grid">
            <label>名称前缀<input value={namePrefix} onChange={(event) => setNamePrefix(event.target.value)} /></label>
            <label>有效期小时<NumberInput value={expiresInHours} onChange={setExpiresInHours} /></label>
            <label className="checkbox-label"><input type="checkbox" checked={keepOriginalHost} onChange={(event) => setKeepOriginalHost(event.target.checked)} />保留原始 Host/SNI</label>
          </div>
          <div className="selected-box">
            <strong>当前选中优选地址</strong>
            <span>{selectedAddresses.length > 0 ? selectedAddresses.join(', ') : '未选择 Agent 结果，将使用手动优选地址。'}</span>
          </div>
          <label className="wide-label">手动优选地址<textarea value={manualPreferred} onChange={(event) => setManualPreferred(event.target.value)} placeholder="一行一个 IP/域名，例如 1.1.1.1:443#home" /></label>
          <label className="wide-label">节点文本<textarea value={nodeText} onChange={(event) => setNodeText(event.target.value)} placeholder="粘贴 vmess/vless/trojan 或 Base64 订阅内容" /></label>
          <label className="wide-label">远程订阅 URL<input value={subscriptionUrl} onChange={(event) => setSubscriptionUrl(event.target.value)} placeholder="https://example.com/sub" /></label>
          <button className="primary" onClick={createSubscription}><Download size={16} />生成临时订阅地址</button>
        </Panel>

        <Panel title="订阅链接" icon={<Copy size={18} />}>
          {subscription ? (
            <div className="links">
              {Object.entries(subscription.urls).map(([name, url]) => (
                <div className="link-row" key={name}>
                  <span>{name}</span>
                  <code>{url}</code>
                  <button title={`复制 ${name}`} onClick={() => copy(url)}><Copy size={16} /></button>
                </div>
              ))}
              <div className="expiry"><Clock size={16} />有效至 {new Date(subscription.expiresAt).toLocaleString()}</div>
              <p>生成节点数：{subscription.nodeCount}</p>
            </div>
          ) : (
            <div className="empty">生成后这里会显示 Raw、Clash、Surge、v2rayN 四类临时订阅链接。</div>
          )}
        </Panel>
      </section>
    </div>
  );
}

function HistoryPanel({ history, openJob }) {
  return (
    <section className="grid two">
      <Panel title="历史任务" icon={<Activity size={18} />}>
        <div className="history-list">
          {history.jobs.map((item) => (
            <button key={item.id} onClick={() => openJob(item.id)}>
              <strong>{item.agent_name || item.agent_id}</strong>
              <span>{item.status} · {new Date(item.created_at).toLocaleString()}</span>
            </button>
          ))}
          {history.jobs.length === 0 && <div className="empty">暂无历史任务。</div>}
        </div>
      </Panel>
      <Panel title="历史订阅" icon={<Link size={18} />}>
        <div className="history-list">
          {history.subscriptions.map((item) => (
            <div key={item.id} className="history-item">
              <strong>{item.name_prefix} · {item.id.slice(0, 8)}</strong>
              <span>{item.node_input_summary}</span>
              <small>{item.expires_at ? `有效至 ${new Date(item.expires_at).toLocaleString()}` : '无过期时间'}</small>
            </div>
          ))}
          {history.subscriptions.length === 0 && <div className="empty">暂无历史订阅。</div>}
        </div>
      </Panel>
    </section>
  );
}

function TutorialsPanel({ agentToken, baseUrl, copy }) {
  const linuxDir = '/home/fran/cloudflare-cdn-sub';
  const windowsDir = 'C:\\cloudflare-cdn-sub';
  const macDir = '~/cloudflare-cdn-sub';
  const agentPlaceholder = agentToken || '<AGENT_TOKEN>';
  const basePlaceholder = baseUrl || 'http://<服务端IP>:8787';
  const tutorials = [
    {
      id: 'windows',
      title: 'Windows 10/11',
      note: '使用 PowerShell。首次启动 agent 时，Windows 防火墙如弹窗，请允许专用网络访问。',
      steps: [
        '安装 Node.js 20 LTS。',
        `把项目复制到 ${windowsDir}。`,
        '执行安装、下载 CFST、启动 agent。',
        '回到网页的 Agent优选IP 页面，选择 Windows-PC 后开始测速。'
      ],
      code: `cd ${windowsDir}\nnpm install\nnpm run cfst:install\nnpm run agent -- --server ${basePlaceholder} --token ${agentPlaceholder} --name Windows-PC`,
      serverCode: `cd ${windowsDir}\nnpm install\nnpm run build\nnpm run serve:daemon`
    },
    {
      id: 'linux',
      title: 'Linux / NAS / 旁路由',
      note: '适合 Ubuntu、Debian、Fedora、Arch、NAS Linux 和旁路由 Linux。',
      steps: [
        '确认 Node.js 20 和 npm 可用。',
        '进入项目目录并安装依赖。',
        '下载对应架构的 CloudflareSpeedTest。',
        '启动 agent 后在网页选择设备测速。'
      ],
      code: `cd ${linuxDir}\nnpm install\nnpm run cfst:install\nnpm run agent -- --server ${basePlaceholder} --token ${agentPlaceholder} --name Linux-PC`,
      serverCode: `cd ${linuxDir}\nnpm install\nnpm run build\nnpm run serve:daemon`
    },
    {
      id: 'macos',
      title: 'macOS Intel / Apple Silicon',
      note: '使用 Terminal。可从 Node.js 官网安装 Node 20，也可用 Homebrew。',
      steps: [
        '安装 Node.js 20 LTS。',
        '复制项目到 Mac 并进入目录。',
        '下载 CFST 并启动 agent。',
        '如果系统拦截二进制，移除 quarantine 标记。'
      ],
      code: `cd ${macDir}\nnpm install\nnpm run cfst:install\nnpm run agent -- --server ${basePlaceholder} --token ${agentPlaceholder} --name MacBook`,
      extraCode: `chmod +x vendor/cfst/current/cfst\nxattr -d com.apple.quarantine vendor/cfst/current/cfst 2>/dev/null || true`,
      serverCode: `cd ${macDir}\nnpm install\nnpm run build\nnpm run serve:daemon`
    },
    {
      id: 'android',
      title: 'Android Termux',
      note: 'Android 可以用 Termux 跑真实 agent；测速代表手机本机网络。',
      steps: [
        '安装 Termux。',
        '在 Termux 安装 Node.js 和基础工具。',
        '复制或拉取项目目录。',
        '运行 CFST 安装和 agent 命令。'
      ],
      code: `pkg update\npkg install nodejs git tar unzip\ncd ~/cloudflare-cdn-sub\nnpm install\nnpm run cfst:install\nnpm run agent -- --server ${basePlaceholder} --token ${agentPlaceholder} --name Android-Phone`
    },
    {
      id: 'ios',
      title: 'iOS / iPadOS',
      note: 'iOS 不能直接跑当前 Linux/Node/CFST agent。推荐用无Agent测速做浏览器体验测试，或在路由器/旁路由/NAS 跑 agent。',
      steps: [
        `Safari 打开 ${basePlaceholder}。`,
        '输入管理 token。',
        '使用无Agent测速查看 iPhone 当前访问 Cloudflare 的体验。',
        '如需生成优选 IP 订阅，请使用路由器/旁路由/NAS/电脑上的 agent 结果，或手填已有优选 IP。'
      ],
      code: `Safari 打开：${basePlaceholder}\n分享菜单 -> 添加到主屏幕`
    }
  ];

  return (
    <div className="tab-stack">
      <section className="hero-panel tutorial-hero">
        <div>
          <h2>各操作系统使用教程</h2>
          <p>这里的命令已按当前服务地址生成。先看最终订阅生成流程，再按系统启动对应设备。</p>
        </div>
        <button onClick={() => copy(basePlaceholder)}><Copy size={16} />复制服务地址</button>
      </section>

      <section className="grid two">
        <Panel title="从 Agent 测速结果生成最终订阅" icon={<Link size={18} />}>
          <ol className="flow-list">
            <li>在目标设备启动 agent，网页进入“Agent优选IP”。</li>
            <li>选择在线设备，点击“开始真实优选”。</li>
            <li>测速完成后勾选要使用的优选 IP。</li>
            <li>进入“临时订阅”，确认“当前选中优选地址”已显示刚才勾选的 IP。</li>
            <li>粘贴原始节点文本，或填写远程订阅 URL。</li>
            <li>设置名称前缀、有效期、是否保留原始 Host/SNI。</li>
            <li>点击“生成临时订阅地址”，复制 Raw / Clash / Surge / v2rayN 链接到客户端。</li>
          </ol>
        </Panel>

        <Panel title="不用 Agent 时手动生成订阅" icon={<Wifi size={18} />}>
          <ol className="flow-list">
            <li>“无Agent测速”只判断当前浏览器访问 Cloudflare 的体验，不会产生优选 IP。</li>
            <li>进入“临时订阅”，在“手动优选地址”填写已有 IP 或域名。</li>
            <li>格式为一行一个：<code>1.1.1.1:443#home</code>。</li>
            <li>粘贴节点文本或填写远程订阅 URL。</li>
            <li>点击“生成临时订阅地址”，复制需要的订阅格式。</li>
          </ol>
        </Panel>
      </section>

      <section className="tutorial-grid">
        {tutorials.map((item) => (
          <article className="tutorial-card" key={item.id}>
            <div className="tutorial-card-head">
              <h3>{item.title}</h3>
              <span>{item.note}</span>
            </div>
            <ol>
              {item.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            <CodeBlock label="Agent 命令" code={item.code} copy={copy} />
            {item.extraCode && <CodeBlock label="故障处理" code={item.extraCode} copy={copy} />}
            {item.serverCode && <CodeBlock label="作为 Web 服务端" code={item.serverCode} copy={copy} />}
          </article>
        ))}
      </section>
    </div>
  );
}

function CodeBlock({ label, code, copy }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{label}</span>
        <button title={`复制 ${label}`} onClick={() => copy(code)}><Copy size={14} /></button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function Panel({ title, icon, children }) {
  return (
    <section className="panel">
      <div className="panel-title">{icon}<h2>{title}</h2></div>
      {children}
    </section>
  );
}

function Metric({ title, value }) {
  return (
    <section className="metric">
      <span>{title}</span>
      <strong>{value}</strong>
    </section>
  );
}

function NumberInput({ value, onChange }) {
  return <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />;
}

function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
    </select>
  );
}

async function measureLatency() {
  const start = performance.now();
  const response = await fetch(`https://speed.cloudflare.com/__down?bytes=0&t=${Date.now()}-${Math.random()}`, { cache: 'no-store', mode: 'cors' });
  await response.arrayBuffer();
  return performance.now() - start;
}

async function measureDownload(bytes) {
  const start = performance.now();
  const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}&t=${Date.now()}-${Math.random()}`, { cache: 'no-store', mode: 'cors' });
  const buffer = await response.arrayBuffer();
  const seconds = (performance.now() - start) / 1000;
  return { bytes: buffer.byteLength || bytes, seconds, mbps: (buffer.byteLength || bytes) * 8 / 1024 / 1024 / seconds };
}

async function measureUpload(bytes) {
  const body = new Uint8Array(bytes);
  const start = performance.now();
  const response = await fetch(`https://speed.cloudflare.com/__up?t=${Date.now()}-${Math.random()}`, {
    method: 'POST',
    body,
    cache: 'no-store',
    mode: 'cors'
  });
  await response.text();
  const seconds = (performance.now() - start) / 1000;
  return { bytes, seconds, mbps: bytes * 8 / 1024 / 1024 / seconds };
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : '-';
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

createRoot(document.getElementById('root')).render(<App />);
