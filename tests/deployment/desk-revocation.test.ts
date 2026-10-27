import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request, type IncomingHttpHeaders, type ServerResponse} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scryptSync} from 'node:crypto';

const origin = 'https://cop-revocation.example.test';
const password = 'synthetic-revocation-password';
const evidence = 'SYNTHETIC_EVIDENCE_MUST_NOT_RETURN_AFTER_LOGOUT';
const script = fileURLToPath(new URL('../../scripts/serve-desk.mjs', import.meta.url));

function send(port: number, path: string, {method = 'GET', cookie, body}: {method?: string; cookie?: string; body?: string} = {}) {
  return new Promise<{status: number; headers: IncomingHttpHeaders; body: string}>((resolve, reject) => {
    const headers: Record<string, string> = {Host: new URL(origin).host, Origin: origin};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = path === '/auth/login' ? 'application/x-www-form-urlencoded' : 'application/json';
    const req = request({hostname: '127.0.0.1', port, path, method, headers}, res => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', chunk => result += chunk);
      res.on('end', () => resolve({status: res.statusCode!, headers: res.headers, body: result}));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic revocation request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

test('real desk rejects an MCP response after its authenticated session is logged out', {timeout: 15_000}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dhwp-revocation-'));
  let release: (() => void) | undefined;
  let toolCalls = 0;
  let signalArrival!: () => void;
  const arrived = new Promise<void>(resolve => { signalArrival = resolve; });
  // Loopback-only synthetic Streamable HTTP MCP. The second result is released
  // explicitly after logout, so the regression does not depend on timing sleeps.
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {id?: number; method?: string; params?: {name: string}};
    const reply = (result: unknown, response: ServerResponse = res) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
    };
    if (body.method === 'initialize') {
      reply({protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'synthetic-revocation', version: '1.0'}});
    } else if (body.method === 'tools/call') {
      toolCalls++;
      const complete = () => reply({content: [], structuredContent: {ok: true, tool: body.params?.name, data: {evidenceStatus: 'partial', excerpt: evidence}}});
      if (toolCalls === 2) { release = complete; signalArrival(); }
      else complete();
    } else res.writeHead(202).end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress === 'object');

  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<number | null> | undefined;
  let stderr = '';
  try {
    await mkdir(resolve(root, 'dist/desk'), {recursive: true});
    await writeFile(resolve(root, 'dist/static-manifest.json'), JSON.stringify({version: 'fixture', files: {}}));
    const authFile = resolve(root, 'auth.json');
    const salt = Buffer.alloc(16, 11);
    await writeFile(authFile, JSON.stringify({version: 1, salt: salt.toString('hex'), passwordHash: scryptSync(password, salt, 32).toString('hex')}), {mode: 0o600});
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address(); assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
      cwd: root,
      env: {PATH: process.env.PATH, PORT: String(port), DHWP_DESK_PUBLIC_ORIGIN: origin, DHWP_DESK_AUTH_FILE: authFile,
        DHWP_RULES_MCP_URL: `http://127.0.0.1:${upstreamAddress.port}/mcp`},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', chunk => stderr += chunk);
    exited = new Promise<number | null>((resolve, reject) => { child!.once('exit', resolve); child!.once('error', reject); });
    const ready = new Promise<void>(resolve => child!.stdout!.once('data', () => resolve()));
    await Promise.race([ready, exited.then(() => { throw new Error('Synthetic desk startup failed: ' + stderr); })]);

    const login = await send(port, '/auth/login', {method: 'POST', body: new URLSearchParams({password}).toString()});
    assert.equal(login.status, 303);
    const cookie = login.headers['set-cookie']?.[0]?.split(';')[0]; assert.ok(cookie);
    const lookup = () => send(port, '/api/assistant/rules', {method: 'POST', cookie, body: JSON.stringify({operation: 'lookup', query: '합성 규정'})});
    const before = await lookup();
    assert.equal(before.status, 200);
    assert.equal(JSON.parse(before.body).ok, true);
    assert.ok(before.body.includes(evidence), 'control request must reach the real adapter and return synthetic evidence');

    const pending = lookup();
    await Promise.race([arrived, pending.then(() => { throw new Error('Expected a pending upstream request'); })]);
    const logout = await send(port, '/auth/logout', {method: 'POST', cookie});
    assert.equal(logout.status, 303);
    assert.match(logout.headers['set-cookie']![0], /Max-Age=0/);
    release!(); release = undefined;
    const revoked = await pending;
    assert.equal(revoked.status, 401);
    assert.equal(JSON.parse(revoked.body).error.code, 'AUTH_REQUIRED');
    assert.equal(revoked.headers['cache-control'], 'private, no-store');
    assert.ok(!revoked.body.includes(evidence), 'a completed upstream response must not leak after session revocation');
    assert.equal((await lookup()).status, 401);
    assert.equal(toolCalls, 2, 'a revoked cookie must not start any more MCP calls');
    assert.equal(stderr, '');
  } finally {
    release?.();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  }
});
