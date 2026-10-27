export interface DeskOriginOptions {
  port: number;
  publicOrigin?: string;
  authFile?: string;
}

/** A single configured origin is authoritative; proxy headers cannot override it. */
export function resolveDeskOrigin(options: DeskOriginOptions): { origin: string; host: string; isPublic: boolean } {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid PORT');
  if (options.publicOrigin === undefined) {
    const origin = `http://127.0.0.1:${options.port}`;
    return { origin, host: new URL(origin).host, isPublic: false };
  }
  let url: URL;
  try { url = new URL(options.publicOrigin); } catch { throw new Error('Invalid DHWP_DESK_PUBLIC_ORIGIN'); }
  if (url.protocol !== 'https:' || url.origin !== options.publicOrigin || url.username || url.password) {
    throw new Error('Invalid DHWP_DESK_PUBLIC_ORIGIN');
  }
  if (!options.authFile?.trim()) throw new Error('Public desk requires DHWP_DESK_AUTH_FILE');
  return { origin: url.origin, host: url.host, isPublic: true };
}
