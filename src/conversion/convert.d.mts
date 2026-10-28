export interface ConversionMetric {stage:string;phase:'start'|'finish'|'failed';durationMs?:number;rssBytes?:number;failureReason?:string;pageNumber?:number;pageCount?:number;svgBytes?:number;}
export interface ConversionOptions {timeoutMs?:number;signal?:AbortSignal;onMetric?:(metric:ConversionMetric)=>void;onPdf?:(pdf:Buffer,pageCount:number)=>Promise<void>|void;onPage?:(page:PageImage,pageCount:number)=>Promise<void>|void;}
export class ConversionError extends Error {code:string;stage:string;}
export function validMetric(value:unknown):ConversionMetric|undefined;
export const MAX_PDF_BYTES:number;
export const MAX_PNG_BYTES:number;
export const MAX_PNG_TOTAL_BYTES:number;
export const MAX_PREVIEW_PAGES:number;
export const MAX_MARKDOWN_BYTES:number;
export interface PageImage {page:number;png:Buffer;}
export interface PageImages {pageCount:number;pages:PageImage[];}
export interface Preview extends PageImages {pdf:Buffer;}
export function convertPdf(bytes:Uint8Array,options?:ConversionOptions):Promise<Buffer>;
export function convertMarkdown(bytes:Uint8Array,options?:ConversionOptions):Promise<Buffer>;
export function convertPreview(bytes:Uint8Array,options?:ConversionOptions):Promise<Preview>;
export function convertPageImages(bytes:Uint8Array,options?:ConversionOptions&{start?:number;end?:number}):Promise<PageImages>;

export function closeConversionRuntime():Promise<void>;
