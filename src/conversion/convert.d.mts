export interface ConversionMetric {stage:string;phase:'start'|'finish'|'failed';durationMs?:number;rssBytes?:number;failureReason?:string;pageNumber?:number;pageCount?:number;svgBytes?:number;}
export interface ConversionOptions {timeoutMs?:number;signal?:AbortSignal;onMetric?:(metric:ConversionMetric)=>void;onPdf?:(pdf:Buffer,pageCount:number)=>Promise<void>|void;onPage?:(page:PageImage,pageCount:number)=>Promise<void>|void;}
export class ConversionError extends Error {code:string;stage:string;}
export function validMetric(value:unknown):ConversionMetric|undefined;
export const MAX_PDF_BYTES:number;
export const MAX_PNG_BYTES:number;
export const MAX_PNG_TOTAL_BYTES:number;
export const MAX_PREVIEW_PAGES:number;
export const MAX_MARKDOWN_BYTES:number;
export const MAX_TEXT_BYTES:number;
export const MAX_ZIP_BYTES:number;
export const MAX_MARKDOWN_PACKAGE_BYTES:number;
export const MAX_MARKDOWN_REPORT_BYTES:number;
export interface MarkdownPackage {markdown:Buffer;zip:Buffer;report:Record<string,unknown>;}
export interface PageImage {page:number;png:Buffer;}
export interface PageImages {pageCount:number;pages:PageImage[];}
export interface Preview extends PageImages {pdf:Buffer;}
export interface SelectedPageOptions extends ConversionOptions {pages:readonly number[];}
export interface PageZip {pageCount:number;pages:number[];zip:Buffer;}
export function convertPdf(bytes:Uint8Array,options?:ConversionOptions):Promise<Buffer>;
export function convertMarkdown(bytes:Uint8Array,options?:ConversionOptions):Promise<Buffer>;
export function convertMarkdownPackage(bytes:Uint8Array,options?:ConversionOptions):Promise<MarkdownPackage>;
export function convertText(bytes:Uint8Array,options?:ConversionOptions):Promise<Buffer>;
export function convertSelectedPageImages(bytes:Uint8Array,options:SelectedPageOptions):Promise<PageImages>;
export function convertPageZip(bytes:Uint8Array,options:SelectedPageOptions):Promise<PageZip>;
export function convertPreview(bytes:Uint8Array,options?:ConversionOptions):Promise<Preview>;
export function convertPageImages(bytes:Uint8Array,options?:ConversionOptions&{start?:number;end?:number}):Promise<PageImages>;

export function closeConversionRuntime():Promise<void>;
