// pearld clients from environment variables. With no PEARLD_URL, the public
// pearlchain.live endpoint, as pearljs's "Choosing a backend" guide sets it up.
// A node of your own serves RPC and its websocket over TLS with its own
// self-signed rpc.cert; undici's fetch and WebSocket accept it through an
// Agent, as pearljs's docs describe.
import { readFileSync } from 'node:fs';
import { Agent, WebSocket, fetch } from 'undici';
import { PearlWsClient, PearldClient, networks, type BlockchainInfo, type CallOptions, type PearlNetwork, type PearlNetworkName } from 'pearljs';
import { pacedFetch } from './pace.js';

export const PUBLIC_RPC = 'https://pearlchain.live/rpc';

// The public endpoint refuses btcd's getbestblock, which the chain follower
// asks for; getblockchaininfo has the same tip in one allowed call.
class PublicClient extends PearldClient {
  override async call<T = unknown>(method: string, params?: readonly unknown[], options?: CallOptions): Promise<T> {
    if (method !== 'getbestblock') return super.call<T>(method, params, options);
    const info = await super.call<BlockchainInfo>('getblockchaininfo', [], options);
    return { hash: info.bestblockhash, height: info.blocks } as T;
  }
}

export interface NodeConfig {
  client: PearldClient;
  /** Wakes the follower when pearld announces a block, instead of waiting for its next poll. Null on the public endpoint. */
  ws: PearlWsClient | null;
  network: PearlNetwork;
  /** True on the public endpoint, which serves mainnet only and is rate limited. */
  shared: boolean;
}

/**
 * PEARLD_URL (https://127.0.0.1:44107 on mainnet), PEARLD_USER and
 * PEARLD_PASS, PEARLD_CERT (path to rpc.cert, for https), PEARL_NETWORK
 * (mainnet unless given). Without PEARLD_URL, the public endpoint.
 */
export function nodeFromEnv(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const name = (env.PEARL_NETWORK ?? 'mainnet') as PearlNetworkName;
  const network = networks[name];
  if (network === undefined) throw new Error(`PEARL_NETWORK=${name} is not one of ${Object.keys(networks).join(', ')}`);
  const url = env.PEARLD_URL;
  if (url === undefined || url === PUBLIC_RPC) {
    if (name !== 'mainnet') throw new Error(`${PUBLIC_RPC} serves mainnet only; set PEARLD_URL for ${name}`);
    // 1.8 tokens a second of the 2 it allows, so retries are for the node being busy, not for us.
    const client = new PublicClient({
      url: PUBLIC_RPC,
      fetch: pacedFetch({ rate: 1.8, burst: 120 }),
      retry: { retries: 5, delay: 1000, maxDelay: 10000 },
      maxConcurrentRequests: 1,
    });
    return { client, ws: null, network, shared: true };
  }
  if (env.PEARLD_USER === undefined || env.PEARLD_PASS === undefined) throw new Error('PEARLD_USER and PEARLD_PASS must be set');
  const login = { username: env.PEARLD_USER, password: env.PEARLD_PASS };
  const dispatcher = env.PEARLD_CERT === undefined ? undefined : new Agent({ connect: { ca: readFileSync(env.PEARLD_CERT, 'utf8') } });
  const extra = dispatcher === undefined ? {} : { dispatcher };
  const client = new PearldClient({ url, ...login, fetch: fetch as unknown as typeof globalThis.fetch, init: extra });
  const ws = new PearlWsClient({ url, ...login, WebSocket, webSocketInit: extra });
  return { client, ws, network, shared: false };
}
