// pearld clients from environment variables. pearld serves RPC and its
// websocket over TLS with its own self-signed rpc.cert; undici's fetch and
// WebSocket accept it through an Agent, as pearljs's docs describe.
import { readFileSync } from 'node:fs';
import { Agent, WebSocket, fetch } from 'undici';
import { PearlWsClient, PearldClient, networks, type PearlNetwork, type PearlNetworkName } from 'pearljs';

export interface NodeConfig {
  client: PearldClient;
  /** Wakes the follower when pearld announces a block, instead of waiting for its next poll. */
  ws: PearlWsClient;
  network: PearlNetwork;
}

/**
 * PEARLD_URL (https://127.0.0.1:44107 on mainnet), PEARLD_USER and
 * PEARLD_PASS, PEARLD_CERT (path to rpc.cert, for https), PEARL_NETWORK
 * (mainnet unless given).
 */
export function nodeFromEnv(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const name = (env.PEARL_NETWORK ?? 'mainnet') as PearlNetworkName;
  const network = networks[name];
  if (network === undefined) throw new Error(`PEARL_NETWORK=${name} is not one of ${Object.keys(networks).join(', ')}`);
  const url = env.PEARLD_URL;
  if (url === undefined) throw new Error('PEARLD_URL is not set');
  if (env.PEARLD_USER === undefined || env.PEARLD_PASS === undefined) throw new Error('PEARLD_USER and PEARLD_PASS must be set');
  const login = { username: env.PEARLD_USER, password: env.PEARLD_PASS };
  const dispatcher = env.PEARLD_CERT === undefined ? undefined : new Agent({ connect: { ca: readFileSync(env.PEARLD_CERT, 'utf8') } });
  const extra = dispatcher === undefined ? {} : { dispatcher };
  const client = new PearldClient({ url, ...login, fetch: fetch as unknown as typeof globalThis.fetch, init: extra });
  const ws = new PearlWsClient({ url, ...login, WebSocket, webSocketInit: extra });
  return { client, ws, network };
}
