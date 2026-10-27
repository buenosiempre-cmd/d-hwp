import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRulesMcp } from '../../src/server/rules-mcp.ts';
import { validateRulesRequest, RULES_MAX_FACT_CHARS, RULES_FACT_KEYS, type RulesReply, type RulesRequest } from '../../src/shared/rules.ts';

const fixture = fileURLToPath(new URL('../fixtures/rules-mcp.mjs', import.meta.url));
function stdio(mode = 'echo', extra: NodeJS.ProcessEnv = {}) {
  return createRulesMcp({ DHWP_RULES_MCP_COMMAND: process.execPath, DHWP_RULES_MCP_ARGS: JSON.stringify([fixture, mode]), ...extra });
}
function data(reply: RulesReply): Record<string, unknown> {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  if (!reply.ok) throw new Error('Expected successful fixture response');
  assert.ok(Number.isFinite(Date.parse(reply.checkedAt)));
  return reply.data;
}
function error(reply: RulesReply, code: string) {
  assert.equal(reply.ok, false);
  if (reply.ok) throw new Error('Expected safe failure');
  assert.equal(reply.error.code, code);
  assert.deepEqual(Object.keys(reply.error).sort(), ['code', 'message']);
  assert.doesNotMatch(JSON.stringify(reply), /synthetic-token|synthetic-private-path|Authorization|\/private\//);
}
type Handler = (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void | Promise<void>;
async function httpFixture(onTool: Handler, onRequest?: (request: IncomingMessage) => void) {
  const server = createServer(async (request, response) => {
    onRequest?.(request);
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (body.method === 'initialize') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-rules', version: '1.0' } } }));
    } else if (body.method === 'tools/call') await onTool(request, response, body);
    else { response.writeHead(202); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
function sendResult(response: ServerResponse, body: Record<string, unknown>, structured: unknown) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: structured } }));
}

test('request validation preserves exact source and copies facts while rejecting arbitrary tools or settings', () => {
  const text = ' \r\n「합성규정」 제1조\t😀\n ';
  assert.deepEqual(validateRulesRequest({ operation: 'citations', text, campus: 'wise' }), { operation: 'citations', text, campus: 'wise' });
  const input = { operation: 'finance' as const, query: '합성 출장 검토', text, facts: { base_date: '2026-01-01' } };
  const output = validateRulesRequest(input);
  input.facts.base_date = '2026-02-01';
  assert.equal(output.operation === 'finance' && output.facts?.base_date, '2026-01-01');
  for (const value of [null, [], {}, { operation: 'callTool' }, { operation: '__proto__' }, { operation: 'status', tool: 'delete_document' }, { operation: 'status', url: 'https://example.invalid' }, { operation: 'status', command: 'sh' }, { operation: 'lookup', query: 'x', lawId: -1 }, { operation: 'lookup', query: 'x', lawId: Number.MAX_SAFE_INTEGER + 1 }, { operation: 'citations', text, campus: 'other' }, { operation: 'finance', query: 'x', facts: { unknown: 'x' } }, { operation: 'finance', query: 'x', facts: JSON.parse('{"__proto__":"x"}') }]) {
    assert.throws(() => validateRulesRequest(value), /규정 요청 형식/);
  }
});

test('all actual finance fact keys and limits are accepted without truncation', () => {
  const facts = Object.fromEntries(RULES_FACT_KEYS.map(key => [key, '가'.repeat(RULES_MAX_FACT_CHARS)]));
  const maximum = { operation: 'finance', query: 'q'.repeat(2000), text: '가'.repeat(20000), facts };
  assert.deepEqual(validateRulesRequest(maximum), maximum);
  assert.throws(() => validateRulesRequest({ ...maximum, text: maximum.text + 'x' }));
  assert.throws(() => validateRulesRequest({ ...maximum, query: maximum.query + 'x' }));
  assert.throws(() => validateRulesRequest({ ...maximum, facts: { base_date: 'x'.repeat(121) } }));
  for (const text of ['', ' \r\n ']) assert.throws(() => validateRulesRequest({ operation: 'citations', text }));
  assert.throws(() => validateRulesRequest({ operation: 'lookup', query: ' ' }));
});

test('missing, malformed or unsafe configuration cannot break editor startup or start a call', async () => {
  const missing = createRulesMcp({});
  assert.equal(missing.configured, false);
  error(await missing.call({ operation: 'status' }), 'NOT_CONFIGURED');
  await missing.close();
  for (const env of [
    { DHWP_RULES_MCP_URL: 'http://example.invalid/mcp' },
    { DHWP_RULES_MCP_URL: 'https://user:synthetic-token@example.invalid/mcp' },
    { DHWP_RULES_MCP_URL: 'file:///private/synthetic' },
    { DHWP_RULES_MCP_URL: 'not a URL' },
    { DHWP_RULES_MCP_COMMAND: 'synthetic', DHWP_RULES_MCP_ARGS: 'not JSON' },
    { DHWP_RULES_MCP_COMMAND: 'synthetic', DHWP_RULES_MCP_ARGS: '{"args":[]}' },
    { DHWP_RULES_MCP_COMMAND: 'synthetic', DHWP_RULES_MCP_ARGS: '[1]' },
    { DHWP_RULES_MCP_COMMAND: 'synthetic', DHWP_RULES_MCP_URL: 'https://example.invalid/mcp' },
    { DHWP_RULES_MCP_TOKEN: 'synthetic-token' },
  ]) {
    const adapter = createRulesMcp(env);
    assert.equal(adapter.configured, false);
    error(await adapter.call({ operation: 'status' }), 'INVALID_CONFIGURATION');
    await adapter.close();
  }
});

test('actual SDK stdio maps exactly four allowed tools and retains partial and needs-input evidence', async () => {
  const adapter = stdio('echo', { DHWP_RULES_FINANCE_ENABLED: 'true', SLACK_BOT_TOKEN: 'synthetic-token' });
  try {
    const requests: [RulesRequest, string, Record<string, unknown>][] = [
      [{ operation: 'status' }, 'get_service_info', {}],
      [{ operation: 'citations', text: '「합성규정」 제1조', campus: 'seoul' }, 'verify_rule_citations', { text: '「합성규정」 제1조', campus: 'seoul' }],
      [{ operation: 'lookup', query: '합성규정', lawId: 12, campus: 'wise' }, 'lookup_dongguk_rule', { query: '합성규정', law_id: 12, campus: 'wise' }],
      [{ operation: 'finance', query: '합성 출장 검토', facts: { travel_scope: '국내' }, text: '합성문' }, 'review_finance_case', { query: '합성 출장 검토', facts: { travel_scope: '국내' }, text: '합성문' }],
    ];
    for (const [request, tool, args] of requests) {
      const reply = await adapter.call(request);
      const value = data(reply);
      assert.equal(reply.ok && reply.tool, tool);
      assert.deepEqual(value.received, args);
      assert.equal(value.evidenceStatus, 'partial');
      assert.deepEqual(value.incompleteReasons, ['EXCERPT_BLOCK_LIMIT']);
      assert.equal(value.evidence_status, 'needs_input');
      assert.equal(value.applicability, 'not_determined');
      assert.equal(value.unrelatedCredentialInherited, false);
      assert.throws(() => process.kill(value.pid as number, 0), /ESRCH/, 'stdio process must be reaped before returning');
    }
  } finally { await adapter.close(); }
});

test('finance is explicitly disabled by default; status reports that local policy', async () => {
  const adapter = stdio();
  try {
    error(await adapter.call({ operation: 'finance', query: '합성 출장' }), 'FINANCE_DISABLED');
    assert.deepEqual(data(await adapter.call({ operation: 'status' })).dhwp, { financeEnabled: false });
  } finally { await adapter.close(); }
});

test('stdio errors, wrong tools and unstructured prose never become successful evidence or expose raw errors', async () => {
  for (const [mode, code] of [['error', 'AMBIGUOUS_RULE'], ['wrong-tool', 'INVALID_RESPONSE'], ['malformed', 'INVALID_RESPONSE']]) {
    const adapter = stdio(mode);
    try { error(await adapter.call({ operation: 'status' }), code); } finally { await adapter.close(); }
  }
  const adapter = createRulesMcp({ DHWP_RULES_MCP_COMMAND: '/private/synthetic-private-path/nonexistent' });
  try {
    error(await adapter.call({ operation: 'status' }), 'UPSTREAM_UNAVAILABLE');
    error(await adapter.call({ operation: 'status', tool: 'other' } as unknown as RulesRequest), 'INVALID_REQUEST');
  } finally { await adapter.close(); }
});

test('parallel calls own separate stdio clients and closing the adapter rejects pending and future calls', async () => {
  const adapter = stdio('delay');
  const values = await Promise.all([adapter.call({ operation: 'lookup', query: '첫째' }), adapter.call({ operation: 'lookup', query: '둘째' })]);
  assert.notEqual(data(values[0]).pid, data(values[1]).pid);
  assert.deepEqual(data(values[0]).received, { query: '첫째' });
  assert.deepEqual(data(values[1]).received, { query: '둘째' });
  const pending = Array.from({ length: 4 }, () => adapter.call({ operation: 'status' }));
  error(await adapter.call({ operation: 'status' }), 'BUSY');
  await adapter.close();
  for (const reply of await Promise.all(pending)) error(reply, 'CLOSED');
  error(await adapter.call({ operation: 'status' }), 'CLOSED');
  await adapter.close();
});

test('HTTP SDK sends credentials only to configured endpoint and preserves structured partial state', async () => {
  const fixture = await httpFixture((request, response, body) => {
    assert.equal(request.url, '/mcp');
    assert.equal(request.headers.authorization, 'Bearer synthetic-token');
    const params = body.params as { name: string; arguments: unknown };
    assert.equal(params.name, 'lookup_dongguk_rule');
    assert.deepEqual(params.arguments, { query: '합성규정' });
    sendResult(response, body, { ok: true, tool: params.name, data: { evidenceStatus: 'partial', rules: [{ excerpt: { text: '합성 근거', truncated: true } }], incompleteReasons: ['HWP_FALLBACK'] } });
  });
  const adapter = createRulesMcp({ DHWP_RULES_MCP_URL: fixture.url, DHWP_RULES_MCP_TOKEN: 'synthetic-token' });
  try {
    const value = data(await adapter.call({ operation: 'lookup', query: '합성규정' }));
    assert.equal(value.evidenceStatus, 'partial');
    assert.deepEqual(value.incompleteReasons, ['HWP_FALLBACK']);
  } finally { await adapter.close(); await fixture.close(); }
});

test('HTTP redirects are never followed and unknown upstream errors are sanitized', async () => {
  let redirectedRequests = 0;
  const target = await httpFixture(() => {}, () => { redirectedRequests++; });
  const redirect = await httpFixture((_request, response) => { response.writeHead(307, { Location: target.url }); response.end(); });
  const adapter = createRulesMcp({ DHWP_RULES_MCP_URL: redirect.url, DHWP_RULES_MCP_TOKEN: 'synthetic-token' });
  try {
    error(await adapter.call({ operation: 'status' }), 'UPSTREAM_UNAVAILABLE');
    assert.equal(redirectedRequests, 0);
  } finally { await adapter.close(); await redirect.close(); await target.close(); }
  const upstream = await httpFixture((_request, response, body) => sendResult(response, body, { ok: false, tool: 'get_service_info', error: { code: 'synthetic-token', message: '/private/synthetic-private-path', details: { token: 'synthetic-token' } } }));
  const errorAdapter = createRulesMcp({ DHWP_RULES_MCP_URL: upstream.url });
  try { error(await errorAdapter.call({ operation: 'status' }), 'UPSTREAM_ERROR'); } finally { await errorAdapter.close(); await upstream.close(); }
});

test('HTTP bodies are bounded even when streamed without a content-length header', async () => {
  for (const declared of [true, false]) {
    const fixture = await httpFixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      if (declared) response.setHeader('content-length', 2 * 1024 * 1024);
      response.write('x'.repeat(700_000));
      response.end('x'.repeat(700_000));
    });
    const adapter = createRulesMcp({ DHWP_RULES_MCP_URL: fixture.url });
    try { error(await adapter.call({ operation: 'status' }), 'RESPONSE_TOO_LARGE'); } finally { await adapter.close(); await fixture.close(); }
  }
});

test('a hanging HTTP tool call times out and closes its request', { timeout: 30_000 }, async () => {
  let requestClosed = false;
  const fixture = await httpFixture((_request, response) => { response.on('close', () => { requestClosed = true; }); });
  const adapter = createRulesMcp({ DHWP_RULES_MCP_URL: fixture.url });
  const start = Date.now();
  try {
    error(await adapter.call({ operation: 'status' }), 'TIMEOUT');
    assert.ok(Date.now() - start < 25_000);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requestClosed, true);
  } finally { await adapter.close(); await fixture.close(); }
});

test('an already cancelled caller makes no upstream request',async()=>{
  let requests=0;
  const fixture=await httpFixture(()=>{},()=>{requests++;});
  const adapter=createRulesMcp({DHWP_RULES_MCP_URL:fixture.url});
  const controller=new AbortController();controller.abort(new Error('synthetic-token'));
  try{
    error(await adapter.call({operation:'status'},controller.signal),'CANCELLED');
    assert.equal(requests,0);
  }finally{await adapter.close();await fixture.close();}
});

test('caller cancellation closes a hanging HTTP request and permits a fresh lookup',{timeout:10_000},async()=>{
  let started!:()=>void,closed!:()=>void,calls=0;
  const called=new Promise<void>(resolve=>started=resolve);
  const disconnected=new Promise<void>(resolve=>closed=resolve);
  const fixture=await httpFixture((_request,response,body)=>{
    if(++calls===1){response.on('close',closed);started();return;}
    sendResult(response,body,{ok:true,tool:'get_service_info',data:{version:'synthetic'}});
  });
  const adapter=createRulesMcp({DHWP_RULES_MCP_URL:fixture.url});
  const controller=new AbortController();
  const pending=adapter.call({operation:'status'},controller.signal);
  try{
    await called;controller.abort(new Error('synthetic-token'));
    error(await pending,'CANCELLED');
    await disconnected;
    assert.equal(data(await adapter.call({operation:'status'})).version,'synthetic');
  }finally{controller.abort();await pending;await adapter.close();await fixture.close();}
});

test('caller cancellation terminates its stdio child before returning capacity',{timeout:10_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'d-hwp-rules-cancel-'));
  const marker=join(directory,'synthetic-child.pid');
  const adapter=createRulesMcp({DHWP_RULES_MCP_COMMAND:process.execPath,DHWP_RULES_MCP_ARGS:JSON.stringify([fixture,'hang',marker])});
  const controller=new AbortController();
  const pending=adapter.call({operation:'status'},controller.signal);
  try{
    let pid=0;
    for(let attempt=0;attempt<200;attempt++){
      try{pid=Number(await readFile(marker,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}
    }
    assert.ok(pid>0,'synthetic MCP must start before testing in-flight cancellation');
    controller.abort();
    error(await pending,'CANCELLED');
    assert.throws(()=>process.kill(pid,0),/ESRCH/,'cancelled child must be reaped before the call settles');
  }finally{controller.abort();await pending;await adapter.close();await rm(directory,{recursive:true,force:true});}
});
