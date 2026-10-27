/** Browser-safe contract. Connection settings and credentials belong to the server. */
export type RulesOperation = 'status' | 'citations' | 'lookup' | 'finance';
export type RulesCampus = 'all' | 'seoul' | 'wise';
export type RulesRequest =
  | { operation: 'status' }
  | { operation: 'citations'; text: string; campus?: RulesCampus }
  | { operation: 'lookup'; query: string; campus?: RulesCampus; lawId?: number }
  | { operation: 'finance'; query: string; facts?: Record<string, string>; text?: string };
export type RulesReply =
  | { ok: true; operation: RulesOperation; tool: string; checkedAt: string; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };
export type RulesClient = (request: RulesRequest, signal?: AbortSignal) => Promise<RulesReply>;

export const RULES_MAX_TEXT_CHARS = 20_000;
export const RULES_MAX_QUERY_CHARS = 2_000;
// dongguk-rule-mcp v0.12.0's actual review_finance_case schema and runtime limit.
export const RULES_MAX_FACT_CHARS = 120;
export const RULES_FACT_KEYS = [
  'base_date', 'campus', 'accounting_unit', 'purpose', 'payment_route', 'payment_status',
  'evidence_type', 'evidence_status', 'fund_source', 'account_code', 'employee_role',
  'travel_scope', 'employment_relationship', 'tax_residency', 'service_pattern',
  'service_location', 'internal_rule_name',
] as const;

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function invalid(): never { throw new TypeError('규정 요청 형식이 올바르지 않습니다.'); }
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) invalid();
  return value;
}
function campus(value: unknown): RulesCampus | undefined {
  if (value === undefined) return undefined;
  if (value !== 'all' && value !== 'seoul' && value !== 'wise') invalid();
  return value;
}

/** Validate and copy without trimming or silently shortening document contents. */
export function validateRulesRequest(value: unknown): RulesRequest {
  if (!record(value)) invalid();
  const allowed = {
    status: ['operation'], citations: ['operation', 'text', 'campus'],
    lookup: ['operation', 'query', 'campus', 'lawId'], finance: ['operation', 'query', 'facts', 'text'],
  } as const;
  const operation = value.operation;
  if (typeof operation !== 'string' || !Object.hasOwn(allowed, operation)) invalid();
  if (Object.keys(value).some(key => !(allowed[operation as RulesOperation] as readonly string[]).includes(key))) invalid();
  switch (operation) {
    case 'status': return { operation };
    case 'citations': {
      const selectedCampus = campus(value.campus);
      return { operation, text: text(value.text, RULES_MAX_TEXT_CHARS), ...(selectedCampus ? { campus: selectedCampus } : {}) };
    }
    case 'lookup': {
      const selectedCampus = campus(value.campus);
      const lawId = value.lawId;
      if (lawId !== undefined && (typeof lawId !== 'number' || !Number.isSafeInteger(lawId) || lawId <= 0)) invalid();
      return { operation, query: text(value.query, RULES_MAX_QUERY_CHARS), ...(selectedCampus ? { campus: selectedCampus } : {}), ...(lawId === undefined ? {} : { lawId }) };
    }
    case 'finance': {
      const query = text(value.query, RULES_MAX_QUERY_CHARS);
      let facts: Record<string, string> | undefined;
      if (value.facts !== undefined) {
        if (!record(value.facts)) invalid();
        facts = {};
        for (const [key, entry] of Object.entries(value.facts)) {
          if (!(RULES_FACT_KEYS as readonly string[]).includes(key)) invalid();
          facts[key] = text(entry, RULES_MAX_FACT_CHARS, true);
        }
      }
      const source = value.text === undefined ? undefined : text(value.text, RULES_MAX_TEXT_CHARS, true);
      return { operation, query, ...(facts ? { facts } : {}), ...(source === undefined ? {} : { text: source }) };
    }
    default: return invalid();
  }
}
