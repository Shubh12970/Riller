// Minimal typing for the Workers runtime module (runtime-provided, not on npm).
declare module 'cloudflare:node' {
  import type { Server } from 'node:http';
  export function httpServerHandler(server: Server): { fetch(request: Request): Promise<Response> };
}
