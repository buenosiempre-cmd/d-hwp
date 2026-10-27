import type {IncomingMessage, ServerResponse} from 'node:http';
import {validateRulesRequest, type RulesRequest, type RulesReply} from '../shared/rules.ts';

export interface RulesInvoker { call(request: RulesRequest, signal?: AbortSignal): Promise<RulesReply>; }
const MAX_BODY_BYTES = 96 * 1024;
let active = 0;

/** Same-origin/Slack authentication is checked by the owning route, never by MCP. */
export function createRulesHandler(service: RulesInvoker) {
  return async (req: IncomingMessage, res: ServerResponse, authorize: () => Promise<void> = async () => {}): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (reply: RulesReply, status = 200) => {
      if (!res.destroyed && !res.writableEnded) res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}).end(JSON.stringify(reply));
    };
    const fail = (code: string, message: string, status: number) => send({ok: false, error: {code, message}}, status);
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail('METHOD_NOT_ALLOWED', 'POST 요청만 사용할 수 있습니다.', 405); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] ?? ''))) {
      fail('INVALID_CONTENT_TYPE', 'JSON 요청이 필요합니다.', 415); return;
    }
    await authorize();
    if (req.aborted || res.destroyed) return;
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) { fail('PAYLOAD_TOO_LARGE', '검토할 내용이 너무 큽니다. 범위를 줄여 주세요.', 413); return; }
    if (active >= 2) { fail('BUSY', '다른 규정 요청을 처리하고 있습니다. 잠시 후 다시 시도하세요.', 429); return; }
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    active++;
    try {
      const chunks: Buffer[] = []; let size = 0;
      const timer = setTimeout(() => req.destroy(), 15_000);
      try {
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > MAX_BODY_BYTES) { fail('PAYLOAD_TOO_LARGE', '검토할 내용이 너무 큽니다. 범위를 줄여 주세요.', 413); return; }
          chunks.push(bytes);
        }
      } catch { fail('INVALID_REQUEST', '요청을 받지 못했습니다. 다시 시도해 주세요.', 400); return; }
      finally { clearTimeout(timer); }
      let request: RulesRequest;
      try { request = validateRulesRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { fail('INVALID_ARGUMENT', '검토 입력과 글자 수를 확인해 주세요.', 400); return; }
      await authorize();
      if (controller.signal.aborted || req.aborted || res.destroyed) return;
      let reply: RulesReply;
      try { reply = await service.call(request, controller.signal); }
      catch { fail('MCP_UNAVAILABLE', '규정 서비스에 연결하지 못했습니다. 서버 설정을 확인해 주세요.', 502); return; }
      if (controller.signal.aborted || res.destroyed) return;
      // A successful lookup must not be delivered after document access or session expiry.
      await authorize();
      send(reply);
    } finally {
      req.off('aborted', disconnected);
      res.off('close', disconnected);
      // Keep the slot until the service finishes cancelling and closes its transport.
      active--;
    }
  };
}
