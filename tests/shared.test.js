import { describe, expect, it } from 'vitest';
import { buildCfstArgs, parseCfstCsv } from '../src/shared/cfst.js';
import { buildSubscriptionOutputs, parseNodeText } from '../src/shared/subscription.js';

describe('cfst shared helpers', () => {
  it('builds conservative cfst args', () => {
    expect(buildCfstArgs({ count: 10, concurrency: 2, downloadCount: 3, port: 8443 }, {
      outputPath: '/tmp/result.csv',
      ipFilePath: '/tmp/ip.txt'
    })).toEqual([
      '-n', '10',
      '-t', '2',
      '-dn', '3',
      '-dt', '10',
      '-tp', '8443',
      '-p', '0',
      '-f', '/tmp/ip.txt',
      '-o', '/tmp/result.csv'
    ]);
  });

  it('parses chinese cfst csv output', () => {
    const csv = 'IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s),地区码\n1.1.1.1,4,4,0.00%,11.23,8.5,HKG\n';
    expect(parseCfstCsv(csv)).toEqual([
      expect.objectContaining({
        ip: '1.1.1.1',
        sent: 4,
        received: 4,
        lossRatePercent: 0,
        latencyMs: 11.23,
        downloadSpeedMBps: 8.5,
        colo: 'HKG'
      })
    ]);
  });
});

describe('subscription renderer', () => {
  it('expands vless nodes over preferred addresses', () => {
    const outputs = buildSubscriptionOutputs({
      nodeText: 'vless://uuid@example.com:443?security=tls&type=ws&path=%2F#base',
      preferredAddresses: ['1.1.1.1:443#home', '2.2.2.2:8443#backup'],
      keepOriginalHost: true,
      namePrefix: 'CF'
    });
    expect(parseNodeText(outputs.raw)).toHaveLength(2);
    expect(outputs.raw).toContain('1.1.1.1');
    expect(outputs.raw).toContain('2.2.2.2:8443');
    expect(outputs.clash).toContain('type: vless');
    expect(outputs.surge).toContain('[Proxy]');
    expect(Buffer.from(outputs.v2rayn, 'base64').toString('utf8')).toContain('vless://');
    expect(Buffer.from(outputs.shadowrocket, 'base64').toString('utf8')).toContain('vless://');
  });

  it('expands vmess nodes', () => {
    const payload = Buffer.from(JSON.stringify({
      v: '2',
      ps: 'base',
      add: 'origin.example.com',
      port: '443',
      id: '00000000-0000-0000-0000-000000000000',
      aid: '0',
      net: 'ws',
      type: 'none',
      host: '',
      path: '/',
      tls: 'tls'
    })).toString('base64');
    const outputs = buildSubscriptionOutputs({
      nodeText: `vmess://${payload}`,
      preferredAddresses: ['1.1.1.1#best'],
      keepOriginalHost: true,
      namePrefix: 'CF'
    });
    expect(outputs.raw).toContain('vmess://');
    expect(outputs.clash).toContain('servername: origin.example.com');
  });
});
