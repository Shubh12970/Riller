/**
 * Cloudflare Worker entry - wraps the same Express demo app so it runs on
 * Cloudflare's free tier. httpServerHandler (from the cloudflare:node runtime
 * module) bridges the Worker's fetch event to a Node-style http.Server, which
 * is what Express speaks. The static dashboard in public/ is served by
 * Workers Static Assets (see wrangler.jsonc); only /api/* and /__rl/*
 * requests reach Express.
 *
 * Honest note for the docs: each Worker isolate has its own memory, so bucket
 * state and the stats chart are per-isolate, not global. Fine for a demo -
 * and exactly the multi-server limitation the Redis store (roadmap) solves.
 */

import http from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { buildApp } from './demo/server.js';

const server = http.createServer(buildApp());

export default httpServerHandler(server);
