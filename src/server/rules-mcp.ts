import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { validateRulesRequest, type RulesReply, type RulesRequest } from '../shared/rules.ts';

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONCURRENT = 4;
const TOOL_NAMES = {
  status: 'get_service_info', citations: 'verify_rule_citations',
  lookup: 'lookup_dongguk_rule', finance: 'review_finance_case',
} as const;
const MESSAGES: Record<string, string> = {
  NOT_CONFIGURED: '규정 MCP가 연결되지 않았습니다. 서버 연결 설정을 확인하세요.',
  INVALID_CONFIGURATION: '규정 MCP 서버 연결 설정을 확인하세요.',
  INVALID_REQUEST: '규정 요청 형식이나 입력 길이를 확인하세요.',
  CLOSED: '규정 연결이 종료되었습니다. 다시 연결한 뒤 요청하세요.',
  CANCELLED: '규정 검토 요청을 취소했습니다.',
  BUSY: '규정 요청이 진행 중입니다. 잠시 뒤 다시 시도하세요.',
  FINANCE_DISABLED: '이 서버에서는 재무 검토 연결을 사용하지 않습니다.',
  TIMEOUT: '규정 조회 제한 시간을 초과했습니다. 잠시 뒤 다시 시도하세요.',
  RESPONSE_TOO_LARGE: '규정 응답이 너무 큽니다. 조회 범위를 줄여 다시 요청하세요.',
  INVALID_RESPONSE: '규정 MCP 응답을 확인할 수 없습니다.',
  UPSTREAM_UNAVAILABLE: '규정 MCP에 연결하지 못했거나 조회를 완료하지 못했습니다.',
  UPSTREAM_ERROR: '규정 MCP가 요청을 완료하지 못했습니다.',
  UPSTREAM_ACCESS_DENIED: '규정 조회 권한을 확인하지 못했습니다. 서버 연결 설정을 확인하세요.',
  TOOL_NOT_AVAILABLE: '연결된 규정 MCP에서는 이 기능을 제공하지 않습니다.',
  INVALID_ARGUMENT: '규정 MCP 입력 조건을 확인하세요.',
  INVALID_DATE: '기준일을 실제 존재하는 날짜로 입력하세요.',
  SENSITIVE_INPUT: '개인번호·계좌·인증정보를 제거한 뒤 요청하세요.',
  NOT_FOUND: '조회할 규정이나 인용을 확인하지 못했습니다.',
  HISTORY_NOT_FOUND: '해당 규정 개정본을 확인하지 못했습니다.',
  AMBIGUOUS_RULE: '규정 후보가 여러 개입니다. 정확한 규정명이나 규정 번호로 다시 조회하세요.',
  FINANCE_PACK_NOT_CONFIGURED: '이 재무 기능에 필요한 내부 자료가 연결되지 않았습니다.',
};
function failure(code: string): RulesReply {
  const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'UPSTREAM_ERROR';
  return { ok: false, error: { code: safeCode, message: MESSAGES[safeCode] } };
}
class SafeFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
type Settings = { mode: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { mode: 'http'; url: URL; token: string };

function settings(env: NodeJS.ProcessEnv): Settings | null {
  const command = env.DHWP_RULES_MCP_COMMAND?.trim();
  const address = env.DHWP_RULES_MCP_URL?.trim();
  if (!command && !address) {
    if (env.DHWP_RULES_MCP_ARGS || env.DHWP_RULES_MCP_TOKEN) throw new SafeFailure('INVALID_CONFIGURATION');
    return null;
  }
  if (command && address) throw new SafeFailure('INVALID_CONFIGURATION');
  if (command) {
    if (command.length > 4096 || /[\0\r\n]/.test(command) || env.DHWP_RULES_MCP_TOKEN) throw new SafeFailure('INVALID_CONFIGURATION');
    const rawArgs = env.DHWP_RULES_MCP_ARGS || '[]';
    if (rawArgs.length > 65_536) throw new SafeFailure('INVALID_CONFIGURATION');
    const args: unknown = JSON.parse(rawArgs);
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new SafeFailure('INVALID_CONFIGURATION');
    // Do not hand unrelated Slack, AI or adapter credentials to the child.
    const childEnv: Record<string, string> = {};
    const inherited = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'LANG', 'LC_ALL']);
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && (inherited.has(key) || /^DONGGUK_[A-Z0-9_]+$/.test(key) || key === 'LAW_OC')) childEnv[key] = value;
    }
    return { mode: 'stdio', command, args: args as string[], env: childEnv };
  }
  if (env.DHWP_RULES_MCP_ARGS) throw new SafeFailure('INVALID_CONFIGURATION');
  const url = new URL(address!);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new SafeFailure('INVALID_CONFIGURATION');
  const token = env.DHWP_RULES_MCP_TOKEN?.trim() || '';
  if (token.length > 8192 || /[\r\n\0]/.test(token)) throw new SafeFailure('INVALID_CONFIGURATION');
  return { mode: 'http', url, token };
}

function toolArguments(request: RulesRequest): Record<string, unknown> {
  switch (request.operation) {
    case 'status': return {};
    case 'citations': return { text: request.text, ...(request.campus ? { campus: request.campus } : {}) };
    case 'lookup': return { query: request.query, ...(request.campus ? { campus: request.campus } : {}), ...(request.lawId === undefined ? {} : { law_id: request.lawId }) };
    case 'finance': return { query: request.query, ...(request.facts ? { facts: request.facts } : {}), ...(request.text === undefined ? {} : { text: request.text }) };
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function result(request: RulesRequest, response: unknown): RulesReply {
  if (Buffer.byteLength(JSON.stringify(response) ?? '', 'utf8') > MAX_RESPONSE_BYTES) return failure('RESPONSE_TOO_LARGE');
  if (!record(response) || response.isError === true || !record(response.structuredContent)) return failure('INVALID_RESPONSE');
  const structured = response.structuredContent;
  if (structured.tool !== TOOL_NAMES[request.operation]) return failure('INVALID_RESPONSE');
  if (structured.ok === false) {
    const code = record(structured.error) && typeof structured.error.code === 'string' ? structured.error.code : 'UPSTREAM_ERROR';
    return failure(code);
  }
  if (structured.ok !== true || !record(structured.data)) return failure('INVALID_RESPONSE');
  return { ok: true, operation: request.operation, tool: TOOL_NAMES[request.operation], checkedAt: new Date().toISOString(), data: structured.data };
}

/** Credentials and destinations are read once, exclusively from server configuration. */
export function createRulesMcp(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  call(request: RulesRequest, signal?: AbortSignal): Promise<RulesReply>;
  close(): Promise<void>;
} {
  let config: Settings | null = null;
  let configurationError = 'NOT_CONFIGURED';
  try { config = settings(env); } catch { configurationError = 'INVALID_CONFIGURATION'; }
  let closed = false;
  const financeEnabled = env.DHWP_RULES_FINANCE_ENABLED === 'true';
  const active = new Set<{ abort: () => void; finished: Promise<void> }>();

  return {
    configured: config !== null,
    async call(input, signal) {
      let request: RulesRequest;
      try { request = validateRulesRequest(input); } catch { return failure('INVALID_REQUEST'); }
      if (signal?.aborted) return failure('CANCELLED');
      if (closed) return failure('CLOSED');
      if (!config) return failure(configurationError);
      if (request.operation === 'finance' && !financeEnabled) return failure('FINANCE_DISABLED');
      if (active.size >= MAX_CONCURRENT) return failure('BUSY');
      const controller = new AbortController();
      const client = new Client({ name: 'd-hwp-rules', version: '0.1.0' }, { capabilities: {} });
      let transport: Transport | undefined;
      let code: string | undefined;
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const stop = (reason: string) => { if (!controller.signal.aborted) { code = reason; controller.abort(); } };
      const abortFromCaller = () => stop('CANCELLED');
      const operation = { abort: () => stop('CLOSED'), finished };
      active.add(operation);
      const timer = setTimeout(() => stop('TIMEOUT'), TIMEOUT_MS);
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new SafeFailure(code || 'CLOSED')), { once: true });
      });
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      try {
        if (signal?.aborted) throw new SafeFailure('CANCELLED');
        if (config.mode === 'stdio') {
          transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'ignore', maxBufferSize: MAX_RESPONSE_BYTES });
        } else {
          const url = config.url.href;
          transport = new StreamableHTTPClientTransport(config.url, {
            requestInit: { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {}, redirect: 'error' },
            // The custom fetch enforces the exact configured URL, no redirects,
            // a response byte budget and the total call deadline, including SSE.
            redirectPolicy: 'follow',
            reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
            fetch: async (target, init) => {
              if (new URL(String(target)).href !== url) throw new SafeFailure('UPSTREAM_UNAVAILABLE');
              const response = await fetch(target, { ...init, redirect: 'error', signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
              if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
                await response.body?.cancel(); stop('RESPONSE_TOO_LARGE'); throw new SafeFailure('RESPONSE_TOO_LARGE');
              }
              if (!response.body) return response;
              let size = 0;
              const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, stream) {
                  size += chunk.byteLength;
                  if (size > MAX_RESPONSE_BYTES) { stop('RESPONSE_TOO_LARGE'); stream.error(new SafeFailure('RESPONSE_TOO_LARGE')); }
                  else stream.enqueue(chunk);
                },
              }));
              return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
            },
          });
        }
        const execute = async () => {
          await client.connect(transport!, { signal: controller.signal, timeout: TIMEOUT_MS });
          controller.signal.throwIfAborted();
          return client.callTool({ name: TOOL_NAMES[request.operation], arguments: toolArguments(request) }, undefined, { signal: controller.signal, timeout: TIMEOUT_MS });
        };
        const reply = result(request, await Promise.race([execute(), aborted]));
        if (reply.ok && request.operation === 'status') reply.data = { ...reply.data, dhwp: { financeEnabled } };
        return reply;
      } catch (error) {
        return failure(code || (error instanceof SafeFailure ? error.code : 'UPSTREAM_UNAVAILABLE'));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromCaller);
        // Closing the transport also terminates stdio children; no response,
        // child stderr or transport exception is logged or exposed to the UI.
        await client.close().catch(() => {});
        await transport?.close().catch(() => {});
        active.delete(operation);
        finish();
      }
    },
    async close() {
      closed = true;
      const pending = [...active];
      for (const operation of pending) operation.abort();
      await Promise.allSettled(pending.map(operation => operation.finished));
    },
  };
}
