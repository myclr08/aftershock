import { describe, expect, it } from 'vitest';
import { ConnectionClosedError, JsonRpcConnection, RpcError } from '../../src/core/jsonRpc';

function pair() {
  const sent: Record<string, unknown>[] = [];
  const connection = new JsonRpcConnection((line) => {
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    sent.push(JSON.parse(line));
  });
  return { connection, sent };
}

describe('JsonRpcConnection', () => {
  it('matches responses by id, also out of order and split across chunks', async () => {
    const { connection, sent } = pair();
    const a = connection.request<string>('impact', { files: ['a'] });
    const b = connection.request<string>('status');
    expect(sent.map((m) => [m.id, m.method])).toEqual([[1, 'impact'], [2, 'status']]);
    connection.receive('{"jsonrpc":"2.0","id":2,"result":"two"}\r\n{"jsonrpc":"2.0",');
    connection.receive('"id":1,"result":"one"}\n');
    await expect(a.result).resolves.toBe('one');
    await expect(b.result).resolves.toBe('two');
  });

  it('turns error answers into RpcError (cancellation detected)', async () => {
    const { connection } = pair();
    const request = connection.request('impact', { files: [] });
    connection.receive('{"jsonrpc":"2.0","id":1,"error":{"code":-32800,"message":"superseded","data":{"reason":"superseded","by":2}}}\n');
    const error = (await request.result.catch((e) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.isCancellation).toBe(true);
    expect(error.cancelReason).toBe('superseded');
  });

  it('delivers notifications and ignores a BOM and blank lines', () => {
    const { connection } = pair();
    const seen: [string, unknown][] = [];
    connection.onNotification((method, params) => seen.push([method, params]));
    connection.receive('\uFEFF{"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"hi"}}\n\n');
    expect(seen).toEqual([['log', { level: 'info', message: 'hi' }]]);
  });

  it('sends $/cancelRequest only for pending requests', () => {
    const { connection, sent } = pair();
    const request = connection.request('impact', { files: [] });
    connection.cancel(request.id);
    connection.cancel(99);
    expect(sent.filter((m) => m.method === '$/cancelRequest')).toEqual([{ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } }]);
  });

  it('rejects pending and later requests when closed', async () => {
    const { connection } = pair();
    const request = connection.request('impact', { files: [] });
    connection.close(new ConnectionClosedError('gone'));
    await expect(request.result).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(connection.request('status').result).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('reports lines that are not JSON', () => {
    const problems: string[] = [];
    const connection = new JsonRpcConnection(() => undefined, (p) => problems.push(p));
    connection.receive('Unhandled exception\n');
    expect(problems).toHaveLength(1);
  });
});
