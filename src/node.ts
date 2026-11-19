// A PearldClient from environment variables. pearld serves RPC over TLS with
// its own self-signed rpc.cert, which Node's fetch only accepts through
// undici; this uses node:https with the certificate as the CA instead.
import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { PearldClient, networks, type PearlNetwork, type PearlNetworkName } from 'pearljs';

function caFetch(ca: string): typeof globalThis.fetch {
  // One kept-alive connection: a TLS handshake per request was most of the indexer's time.
  const agent = new Agent({ ca, keepAlive: true, maxSockets: 4 });
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers));
      const req = request(String(input), { method: init.method ?? 'GET', headers, agent, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502 })));
      });
      req.on('error', reject);
      req.end(typeof init.body === 'string' ? init.body : undefined);
    });
}

export interface NodeConfig {
  client: PearldClient;
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
  const cert = env.PEARLD_CERT;
  const client = new PearldClient({
    url,
    username: env.PEARLD_USER,
    password: env.PEARLD_PASS,
    ...(cert === undefined ? {} : { fetch: caFetch(readFileSync(cert, 'utf8')) }),
  });
  return { client, network };
}
