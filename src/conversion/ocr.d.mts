export interface OcrAsset {name:string;bytes:Uint8Array;mime?:string;}
export interface ExtractedDocument {markdown:Buffer;assets:OcrAsset[];report:Record<string,unknown>;}
export interface OcrOptions {modulePath?:string;modelCachePath?:string;timeoutMs?:number;}
export const OCR_LIMITS:Readonly<{images:number;imageBytes:number;pixels:number;timeoutMs:number}>;
export const OCR_PROFILE:Readonly<{engine:string;version:string;entrySha256:string;distSha256:string;files:number;models:readonly {file:string;sha256:string;bytes:number}[]}>;
export function planOcr(assets:OcrAsset[]):Record<string,unknown>[];
export function applyOcrResults(extracted:ExtractedDocument,records:Record<string,unknown>[],options?:{verified?:boolean;runtimeStatus?:string}):ExtractedDocument;
export function enrichWithOcr(extracted:ExtractedDocument,options?:OcrOptions):Promise<ExtractedDocument>;
export function verifyOcrRuntime(options?:OcrOptions):Promise<{engine:string;version:string;entrySha256:string;distSha256:string;modelsVerified:number;offline:true}>;
