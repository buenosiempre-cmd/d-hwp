export interface ArchiveLimits {
  maxInputBytes?:number;
  maxTotalBytes?:number;
  maxEntryBytes?:number;
  maxEntries?:number;
}
export function readArchive(input:Uint8Array,options?:ArchiveLimits):Map<string,Buffer>;
export function writeArchive(entries:{name:string;bytes:Uint8Array}[],options?:{maxBytes?:number}):Buffer;
