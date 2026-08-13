// TokenPool 上线前回归测试 — validateUpstreamBaseUrl
// 覆盖：pathname 保留、https 强校验、userinfo/query/hash 拒绝、非默认 443 端口拒绝、
//       深路径拒绝、localhost/私网/link-local/internal 拒绝、空/解析失败、空 pathname。
// 不依赖任何 .env 或 Supabase；直接 import gateway.mjs 中的纯函数。
import { validateUpstreamBaseUrl } from '../gateway.mjs';

let pass = 0, fail = 0;
function eq(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, '\n    got:     ', JSON.stringify(got), '\n    expected:', JSON.stringify(expected)); }
}

console.log('== validateUpstreamBaseUrl 回归 ==');

// 1. pathname 保留 — 这是任务要求 #1 的核心回归
eq('保留 /v1 pathname', validateUpstreamBaseUrl('https://api.deepseek.com/v1'),
   { ok: true, host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com/v1' });
eq('保留 /api pathname', validateUpstreamBaseUrl('https://api.example.com/api'),
   { ok: true, host: 'api.example.com', baseUrl: 'https://api.example.com/api' });
eq('拒绝 /openai/v1 深路径', validateUpstreamBaseUrl('https://proxy.example.com/openai/v1'),
   { ok: false, reason: 'deep-path' });
eq('host 大小写归一化', validateUpstreamBaseUrl('https://API.DeepSeek.COM/V1'),
   { ok: true, host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com/V1' });
eq('尾部 / 去除但保留 /v1', validateUpstreamBaseUrl('https://api.deepseek.com/v1/'),
   { ok: true, host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com/v1' });
eq('多个尾部 / 去除', validateUpstreamBaseUrl('https://api.deepseek.com/v1///'),
   { ok: true, host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com/v1' });
eq('纯 host 无路径', validateUpstreamBaseUrl('https://api.deepseek.com'),
   { ok: true, host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com' });
eq('根路径 /', validateUpstreamBaseUrl('https://api.deepseek.com/'),
   { ok: true, host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com' });

// 2. https 强校验
eq('拒绝 http:', validateUpstreamBaseUrl('http://api.deepseek.com/v1'),
   { ok: false, reason: 'protocol-not-https' });
eq('拒绝 ws:', validateUpstreamBaseUrl('ws://api.deepseek.com/v1'),
   { ok: false, reason: 'protocol-not-https' });
eq('拒绝 ftp:', validateUpstreamBaseUrl('ftp://api.deepseek.com/v1'),
   { ok: false, reason: 'protocol-not-https' });

// 3. userinfo / query / hash 拒绝
eq('拒绝 userinfo', validateUpstreamBaseUrl('https://user:pass@api.deepseek.com/v1'),
   { ok: false, reason: 'userinfo' });
eq('拒绝 query', validateUpstreamBaseUrl('https://api.deepseek.com/v1?foo=bar'),
   { ok: false, reason: 'query' });
eq('拒绝 hash', validateUpstreamBaseUrl('https://api.deepseek.com/v1#frag'),
   { ok: false, reason: 'hash' });

// 4. 非默认端口拒绝（仅允许 443）
eq('拒绝端口 8443', validateUpstreamBaseUrl('https://api.deepseek.com:8443/v1'),
   { ok: false, reason: 'non-default-port' });
eq('拒绝端口 80', validateUpstreamBaseUrl('https://api.deepseek.com:80/v1'),
   { ok: false, reason: 'non-default-port' });
eq('接受显式 443', validateUpstreamBaseUrl('https://api.deepseek.com:443/v1'),
   { ok: true, host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com/v1' });

// 5. localhost / 私网 / link-local / internal
eq('拒绝 localhost', validateUpstreamBaseUrl('https://localhost/v1'),
   { ok: false, reason: 'localhost' });
eq('拒绝 127.0.0.1', validateUpstreamBaseUrl('https://127.0.0.1/v1'),
   { ok: false, reason: 'localhost' });
eq('拒绝 10.x', validateUpstreamBaseUrl('https://10.0.0.1/v1'),
   { ok: false, reason: 'private-10' });
eq('拒绝 192.168.x', validateUpstreamBaseUrl('https://192.168.1.1/v1'),
   { ok: false, reason: 'private-192' });
eq('拒绝 172.16-31.x', validateUpstreamBaseUrl('https://172.20.10.5/v1'),
   { ok: false, reason: 'private-172' });
eq('拒绝 link-local 169.254.x', validateUpstreamBaseUrl('https://169.254.169.254/latest'),
   { ok: false, reason: 'link-local' });
eq('拒绝 .internal', validateUpstreamBaseUrl('https://api.internal/v1'),
   { ok: false, reason: 'internal-tld' });
eq('拒绝 .local', validateUpstreamBaseUrl('https://printer.local/v1'),
   { ok: false, reason: 'internal-tld' });

// 5b. IPv6 私网 / 特殊段（v6 防御性加固）
eq('拒绝 IPv6 ::1', validateUpstreamBaseUrl('https://[::1]/v1'),
   { ok: false, reason: 'ipv6-loopback' });
eq('拒绝 IPv6 ULA fc00::', validateUpstreamBaseUrl('https://[fc00::1]/v1'),
   { ok: false, reason: 'ipv6-ula' });
eq('拒绝 IPv6 ULA fd00::', validateUpstreamBaseUrl('https://[fd12:3456:789a::1]/v1'),
   { ok: false, reason: 'ipv6-ula' });
eq('拒绝 IPv6 link-local fe80::', validateUpstreamBaseUrl('https://[fe80::1]/v1'),
   { ok: false, reason: 'ipv6-link-local' });
eq('拒绝 IPv4-mapped ::ffff:127.0.0.1', validateUpstreamBaseUrl('https://[::ffff:127.0.0.1]/v1'),
   { ok: false, reason: 'ipv4-mapped' });
eq('拒绝 IPv4-mapped ::ffff:10.0.0.1', validateUpstreamBaseUrl('https://[::ffff:10.0.0.1]/v1'),
   { ok: false, reason: 'ipv4-mapped' });
eq('拒绝 IPv6 discard 100::', validateUpstreamBaseUrl('https://[100::1]/v1'),
   { ok: false, reason: 'ipv6-discard' });
eq('拒绝 IPv6 unspecified ::', validateUpstreamBaseUrl('https://[::]/v1'),
   { ok: false, reason: 'ipv6-unspecified' });
eq('拒绝 IPv6 multicast ff02::', validateUpstreamBaseUrl('https://[ff02::1]/v1'),
   { ok: false, reason: 'ipv6-multicast' });

// 6. 路径白名单（含智谱 /api/paas/v4）；其余深路径拒绝
eq('拒绝 /v1/chat 深路径', validateUpstreamBaseUrl('https://api.deepseek.com/v1/chat'),
   { ok: false, reason: 'deep-path' });
eq('拒绝 /v1/chat/completions 深路径', validateUpstreamBaseUrl('https://api.deepseek.com/v1/chat/completions'),
   { ok: false, reason: 'deep-path' });
eq('放行智谱 /api/paas/v4', validateUpstreamBaseUrl('https://open.bigmodel.cn/api/paas/v4'),
   { ok: true, host: 'open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' });
eq('放行智谱 /api/paas/v4/（尾斜杠）', validateUpstreamBaseUrl('https://open.bigmodel.cn/api/paas/v4/'),
   { ok: true, host: 'open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' });

// 7. 空 / 解析失败
eq('拒绝空字符串', validateUpstreamBaseUrl(''),
   { ok: false, reason: 'empty' });
eq('拒绝 null', validateUpstreamBaseUrl(null),
   { ok: false, reason: 'empty' });
eq('拒绝 undefined', validateUpstreamBaseUrl(undefined),
   { ok: false, reason: 'empty' });
eq('拒绝垃圾', validateUpstreamBaseUrl('not a url'),
   { ok: false, reason: 'parse' });
eq('拒绝无协议', validateUpstreamBaseUrl('api.deepseek.com/v1'),
   { ok: false, reason: 'parse' });

console.log('\n== 汇总 ==');
console.log('  pass:', pass, ' fail:', fail);
if (fail > 0) {
  console.error('FAIL: ', fail, ' 测试未通过');
  process.exit(1);
} else {
  console.log('ALL PASS');
  process.exit(0);
}
