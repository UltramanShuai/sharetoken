// TokenPool 上线前回归测试 — upstreamFetchAndConsume
// 覆盖：headers 期间超时、body drain 期间超时、SSE 客户端断开 cancel reader、
//       非流 body 正常读出、SSE 流正常消费、4xx/5xx 透传、onHeaders 回调。
// 使用本地 mock upstream（独立 http server）跑真实 fetch + reader 链路。
// 通过 opts.totalBudgetMs 传入短超时，验证真实 deadline 触发（不是 client abort 冒充）。
import { startMockUpstream } from './mock-upstream.mjs';
import { upstreamFetchAndConsume } from '../gateway.mjs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓', name);
  } catch (e) {
    fail++;
    console.error('  ✗', name, '\n    ', e.message);
  }
}

const BASE = (port) => 'http://127.0.0.1:' + port;

console.log('== upstreamFetchAndConsume 回归 ==');

// === 1) 非流成功 ===
{
  const m = await startMockUpstream((req, res) => {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }] }));
  });
  await test('非流：200 + JSON body 正常透传', async () => {
    const r = await upstreamFetchAndConsume(BASE(m.port) + '/chat/completions',
      { method: 'POST', body: '{}' }, null, { isStream: false });
    if (!r.ok) throw new Error('expected ok');
    if (r.status !== 200) throw new Error('status');
    if (!r.body.includes('chatcmpl-1')) throw new Error('body');
  });
  await m.close();
}

// === 2) 非流 4xx 透传 + totalBudgetMs 起作用 ===
{
  const m = await startMockUpstream((req, res) => {
    res.writeHead(401, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  await test('非流：401 透传 body', async () => {
    const r = await upstreamFetchAndConsume(BASE(m.port) + '/x',
      { method: 'POST', body: '{}' }, null, { isStream: false });
    if (r.ok) throw new Error('expected not ok');
    if (r.status !== 401) throw new Error('status ' + r.status);
    if (!r.body.includes('invalid api key')) throw new Error('body');
  });
  await m.close();
}

// === 3) 非流 5xx 透传 ===
{
  const m = await startMockUpstream((req, res) => {
    res.writeHead(503, {'Content-Type':'text/plain'});
    res.end('upstream unavailable');
  });
  await test('非流：503 透传 body', async () => {
    const r = await upstreamFetchAndConsume(BASE(m.port) + '/x',
      { method: 'POST', body: '{}' }, null, { isStream: false });
    if (r.ok) throw new Error('expected not ok');
    if (r.status !== 503) throw new Error('status');
    if (r.body !== 'upstream unavailable') throw new Error('body');
  });
  await m.close();
}

// === 4) SSE 流成功 + onHeaders 触发 ===
{
  const lines = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    '',
    'data: [DONE]',
    ''
  ];
  const m = await startMockUpstream(async (req, res) => {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    for (const ln of lines) {
      res.write(ln + '\n');
      await new Promise(r => setTimeout(r, 5));
    }
    res.end();
  });
  await test('SSE：onHeaders 在 upResp.ok 后调用、onStreamLine 收到全部行', async () => {
    const got = [];
    let headersCalled = false;
    const r = await upstreamFetchAndConsume(BASE(m.port) + '/chat/completions',
      { method: 'POST', body: '{}' }, null, {
        isStream: true,
        onHeaders: async () => { headersCalled = true; },
        onStreamLine: async (line) => { got.push(line); }
      });
    if (!r.ok) throw new Error('not ok');
    if (r.isStream !== true) throw new Error('isStream flag');
    if (!headersCalled) throw new Error('onHeaders not called');
    if (got.length !== lines.length) throw new Error('line count: ' + got.length);
    if (!got.some(l => l.includes('hello'))) throw new Error('missing hello');
    if (!got.some(l => l.includes('world'))) throw new Error('missing world');
  });
  await m.close();
}

// === 5) 客户端断开 → cancel reader + CLIENT_CLOSED ===
{
  const m = await startMockUpstream(async (req, res) => {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      try { res.write('data: line-' + i + '\n\n'); } catch { return; }
    }
    res.end();
  });
  await test('SSE：client abort 在 stream 期间 → 抛 CLIENT_CLOSED，reader 被 cancel', async () => {
    const ac = new AbortController();
    let received = 0;
    const got = [];
    setTimeout(() => ac.abort(), 100);
    let err = null;
    try {
      await upstreamFetchAndConsume(BASE(m.port) + '/chat/completions',
        { method: 'POST', body: '{}' }, ac.signal, {
          isStream: true,
          onStreamLine: async (line) => { received++; got.push(line); }
        });
    } catch (e) { err = e; }
    if (!err) throw new Error('expected throw');
    if (err.code !== 'CLIENT_CLOSED') throw new Error('expected CLIENT_CLOSED, got ' + err.code);
    if (received >= 20) throw new Error('reader should not have drained all chunks');
  });
  await m.close();
}

// === 6) 客户端在调用前已 aborted → 立即抛 CLIENT_CLOSED ===
{
  let upstreamHit = 0;
  const m = await startMockUpstream(async (req, res) => {
    upstreamHit++;
    res.writeHead(200); res.end();
  });
  await test('clientSignal.aborted 在调用前 → 立即 CLIENT_CLOSED', async () => {
    const ac = new AbortController(); ac.abort();
    let err = null;
    try {
      await upstreamFetchAndConsume(BASE(m.port) + '/x',
        { method: 'POST', body: '{}' }, ac.signal, { isStream: false });
    } catch (e) { err = e; }
    if (!err || err.code !== 'CLIENT_CLOSED') throw new Error('expected CLIENT_CLOSED, got ' + (err && err.code));
    if (upstreamHit > 0) throw new Error('should not have hit upstream');
  });
  await m.close();
}

// === 7) HEADERS 阶段超时：mock 不响应，totalBudgetMs=200 ===
{
  const m = await startMockUpstream((req, res) => {
    // 不响应
  });
  await test('headers 挂起 + totalBudgetMs=200 → UPSTREAM_TIMEOUT（不是 CLIENT_CLOSED）', async () => {
    let err = null;
    try {
      await upstreamFetchAndConsume(BASE(m.port) + '/x',
        { method: 'POST', body: '{}' }, null, { isStream: false, totalBudgetMs: 200 });
    } catch (e) { err = e; }
    if (!err || err.code !== 'UPSTREAM_TIMEOUT') throw new Error('expected UPSTREAM_TIMEOUT, got ' + (err && err.code));
    if (!/timeout>200ms/.test(err.message)) throw new Error('expected message timeout>200ms, got ' + err.message);
  });
  await m.close();
}

// === 8) BODY drain 阶段超时：先发 headers 后慢发 body，totalBudgetMs=300 ===
{
  const m = await startMockUpstream(async (req, res) => {
    res.writeHead(200, {'Content-Type':'application/json'});
    // 写完 headers 后慢速发 body：每个 chunk 间隔 100ms，总耗时远 > 300ms
    try { res.write('{"partial":'); } catch {}
    await new Promise(r => setTimeout(r, 100));
    try { res.write('"x"'); } catch {}
    await new Promise(r => setTimeout(r, 500));
    try { res.end('}'); } catch {}
  });
  await test('body drain 期间 totalBudgetMs=300 → UPSTREAM_TIMEOUT，不是 client abort', async () => {
    let err = null;
    try {
      await upstreamFetchAndConsume(BASE(m.port) + '/x',
        { method: 'POST', body: '{}' }, null, { isStream: false, totalBudgetMs: 300 });
    } catch (e) { err = e; }
    if (!err || err.code !== 'UPSTREAM_TIMEOUT') throw new Error('expected UPSTREAM_TIMEOUT, got ' + (err && err.code));
    // 关键：不是 client aborted 冒充
    if (err.code === 'CLIENT_CLOSED') throw new Error('误判为 CLIENT_CLOSED');
  });
  await m.close();
}

// === 9) SSE body 期间超时：先发 headers + 1 行，然后慢发更多，totalBudgetMs=200 ===
{
  const m = await startMockUpstream(async (req, res) => {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.write('data: first\n');
    // 后续 chunk 慢
    await new Promise(r => setTimeout(r, 500));
    try { res.write('data: slow\n\n'); res.end(); } catch {}
  });
  await test('SSE body drain 阶段 totalBudgetMs=200 → UPSTREAM_TIMEOUT + reader cancel', async () => {
    let err = null;
    let lines = 0;
    try {
      await upstreamFetchAndConsume(BASE(m.port) + '/x',
        { method: 'POST', body: '{}' }, null, {
          isStream: true,
          totalBudgetMs: 200,
          onStreamLine: async (line) => { lines++; }
        });
    } catch (e) { err = e; }
    if (!err || err.code !== 'UPSTREAM_TIMEOUT') throw new Error('expected UPSTREAM_TIMEOUT, got ' + (err && err.code));
    if (lines !== 1) throw new Error('expected 1 line received, got ' + lines);
  });
  await m.close();
}

// === 10) onHeaders 抛错 → cancel reader + 抛错 ===
{
  const m = await startMockUpstream(async (req, res) => {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.write('data: a\n\n');
    await new Promise(r => setTimeout(r, 500));
    try { res.end(); } catch {}
  });
  await test('SSE：onHeaders 抛错 → cancel reader + 抛错', async () => {
    let err = null;
    try {
      await upstreamFetchAndConsume(BASE(m.port) + '/x',
        { method: 'POST', body: '{}' }, null, {
          isStream: true,
          onHeaders: async () => { const e = new Error('forced'); e.code = 'CLIENT_CLOSED'; throw e; },
          onStreamLine: async () => {}
        });
    } catch (e) { err = e; }
    if (!err || err.message !== 'forced') throw new Error('expected forced, got ' + (err && err.message));
  });
  await m.close();
}

// === 11) totalBudgetMs 缺省：使用 270000（向后兼容） ===
{
  const m = await startMockUpstream((req, res) => {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end('{"ok":1}');
  });
  await test('totalBudgetMs 缺省：行为如 270s（接口兼容）', async () => {
    const r = await upstreamFetchAndConsume(BASE(m.port) + '/x',
      { method: 'POST', body: '{}' }, null, { isStream: false });
    if (!r.ok) throw new Error('not ok');
    if (r.body !== '{"ok":1}') throw new Error('body');
  });
  await m.close();
}

// === 12) onHeaders 失败 + body 仍会 cancel reader（不会泄漏）===
{
  let remoteClosed = false;
  const m = await startMockUpstream(async (req, res) => {
    res.on('close', () => { remoteClosed = true; });
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.write('data: a\n\n');
    // 保持连接
    setTimeout(() => { try { res.end(); } catch {} }, 500);
  });
  await test('SSE：onHeaders 抛错 → 远端连接被 cancel(reader.cancel 生效)', async () => {
    let err = null;
    try {
      await upstreamFetchAndConsume(BASE(m.port) + '/x',
        { method: 'POST', body: '{}' }, null, {
          isStream: true,
          onHeaders: async () => { const e = new Error('forced'); e.code = 'CLIENT_CLOSED'; throw e; },
          onStreamLine: async () => {}
        });
    } catch (e) { err = e; }
    if (!err) throw new Error('expected throw');
    // 等待 200ms 看远端 close
    await new Promise(r => setTimeout(r, 200));
    if (!remoteClosed) throw new Error('远端连接未关闭（reader.cancel 未生效）');
  });
  await m.close();
}

console.log('\n== 汇总 ==');
console.log('  pass:', pass, ' fail:', fail);
if (fail > 0) {
  console.error('FAIL: ', fail, ' 测试未通过');
  process.exit(1);
} else {
  console.log('ALL PASS');
  process.exit(0);
}
