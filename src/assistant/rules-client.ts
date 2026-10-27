import type {RulesClient, RulesReply} from '../shared/rules';

/** No address, token, document or lookup is stored by this client. */
export function createRulesHttpClient(url: string, options: () => RequestInit = () => ({})): RulesClient {
  return async (request, signal) => {
    const init = options();
    try {
      const headers = new Headers(init.headers);
      headers.set('Content-Type', 'application/json');
      const response = await fetch(url, {
        ...init, method: 'POST', body: JSON.stringify(request), headers,
        credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]),
      });
      const value: unknown = await response.json();
      if (value && typeof value === 'object') {
        const result = value as Record<string, unknown>;
        if (result.ok === false && result.error && typeof result.error === 'object') {
          const error = result.error as Record<string, unknown>;
          if (typeof error.code === 'string' && typeof error.message === 'string') return {ok: false, error: {code: error.code, message: error.message}};
        }
        if (response.ok && result.ok === true && result.operation === request.operation && typeof result.tool === 'string' && typeof result.checkedAt === 'string' && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) return result as unknown as RulesReply;
      }
      return {ok: false, error: {code: response.status === 403 ? 'ACCESS_DENIED' : 'INVALID_RESPONSE', message: response.status === 403 ? '문서 접근 권한이 만료되었거나 요청 출처를 확인하지 못했습니다.' : '규정 서비스의 응답 형식을 확인하지 못했습니다.'}};
    } catch {
      return {ok: false, error: {code: signal?.aborted ? 'CANCELLED' : 'CONNECTION_FAILED', message: signal?.aborted ? '규정 검토 요청을 취소했습니다.' : '규정 서비스에 연결하지 못했습니다. 로컬 서버와 MCP 설정을 확인해 주세요.'}};
    }
  };
}
