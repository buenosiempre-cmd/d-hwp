// Fixed classifications only: never transport exception messages, stacks or document text.
export const FAILURE_REASONS=new Set(['page_count','svg_size','page_size','pdf_size','preview_size','markdown_size','render_error','page_info_error','conversion_error']);
const codes={page_count:'conversion_page_limit',svg_size:'conversion_svg_limit',page_size:'conversion_page_geometry',pdf_size:'conversion_pdf_limit',preview_size:'conversion_preview_limit',markdown_size:'conversion_markdown_limit',render_error:'conversion_render',page_info_error:'conversion_render',conversion_error:'conversion_output'};
export function failureCode(reason){return codes[reason]??'conversion_output';}
export function isPermanentConversionFailure(code){return ['conversion_page_limit','conversion_svg_limit','conversion_page_geometry','conversion_pdf_limit','conversion_preview_limit','conversion_markdown_limit'].includes(code);}
export class ConversionFailure extends Error {constructor(reason){super(reason);this.reason=reason;}}
