import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from '../src/server.js';
import { config, json, ownedAccounts } from './helpers.js';
import type { Fetch } from '../src/http.js';
import { resolve } from 'node:path';

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});
async function connect(
  options: {
    transfers?: boolean;
    approve?: boolean;
    form?: boolean;
    implicitForm?: boolean;
    modern?: boolean;
  } = {},
) {
  const fetcher = vi.fn<Fetch>().mockResolvedValue(json({ accounts: ownedAccounts }));
  const cfg = config({ SB1_ENABLE_TRANSFERS: options.transfers ? 'true' : 'false' });
  const client = new Client(
    { name: 'test', version: '1.0' },
    {
      capabilities: options.implicitForm
        ? { elicitation: {} }
        : options.form
          ? { elicitation: { form: {} } }
          : {},
      ...(options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
    },
  );
  const elicitation = vi.fn(async () => ({
    action: 'accept' as const,
    content: { approve: options.approve ?? false },
  }));
  if (options.form || options.implicitForm)
    client.setRequestHandler('elicitation/create', elicitation);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (options.implicitForm) {
    // The current SDK upgrades its own capability automatically when registering
    // a handler. Preserve the original 2025 declaration on the wire instead.
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => {
      if ('method' in message && message.method === 'initialize' && 'params' in message) {
        message = { ...message, params: { ...message.params, capabilities: { elicitation: {} } } };
      }
      return send(message, options);
    };
  }
  serveStdio((ctx) => createServer(cfg, { fetcher, era: ctx.era }), { transport: serverTransport });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, fetcher, elicitation };
}
function data(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}
const input = {
  transfer: {
    kind: 'account',
    fromAccount: '11111111111',
    toAccount: '22222222222',
    amount: '100.00',
  },
};

describe('MCP client/server integration', () => {
  it('discovers tools with annotations and hides money movement by default', async () => {
    const { client, fetcher } = await connect();
    const list = await client.listTools();
    expect(list.tools).toHaveLength(11);
    expect(list.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(list.tools.map((t) => t.name)).not.toContain('sb1_confirm_transfer');
    expect(fetcher).not.toHaveBeenCalled();
    expect(data(await client.callTool({ name: 'sb1_auth_status', arguments: {} }))).toMatchObject({
      transfersEnabled: false,
    });
  });
  it('returns structured bank data and typed input errors without bank traffic', async () => {
    const { client, fetcher } = await connect();
    const result = await client.callTool({ name: 'sb1_list_accounts', arguments: {} });
    expect(data(result).accounts).toEqual(ownedAccounts);
    fetcher.mockClear();
    // Depending on negotiated protocol, invalid input is either a tool error or a JSON-RPC error.
    const invalid = await client
      .callTool({ name: 'sb1_get_account_balance', arguments: { accountNumber: 'bad' } })
      .catch(() => ({ isError: true }));
    expect(invalid.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('exposes a guide resource and review prompt', async () => {
    const { client } = await connect();
    expect((await client.listResources()).resources[0]?.uri).toBe('sparebank1://guide');
    const guide = await client.readResource({ uri: 'sparebank1://guide' });
    expect(guide.contents[0]).toHaveProperty('text', expect.stringContaining('untrusted data'));
    const prompt = await client.getPrompt({
      name: 'review_transactions',
      arguments: { fromDate: '2026-10-01', toDate: '2026-10-25' },
    });
    expect(prompt.messages[0]?.content).toMatchObject({
      text: expect.stringContaining('Do not initiate transfers'),
    });
  });
  it('requires host form support before submitting a transfer', async () => {
    const { client, fetcher } = await connect({ transfers: true });
    const preview = data(await client.callTool({ name: 'sb1_preview_transfer', arguments: input }));
    const result = await client.callTool({
      name: 'sb1_confirm_transfer',
      arguments: { previewId: preview.previewId },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('CONFIRMATION_UNSUPPORTED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts the original legacy elicitation capability without a form sub-capability', async () => {
    const { client, fetcher, elicitation } = await connect({
      transfers: true,
      implicitForm: true,
      approve: true,
    });
    const preview = data(await client.callTool({ name: 'sb1_preview_transfer', arguments: input }));
    fetcher
      .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
      .mockResolvedValueOnce(json({ paymentId: 'legacy-implicit', warnings: [] }));
    const result = await client.callTool({
      name: 'sb1_confirm_transfer',
      arguments: { previewId: preview.previewId },
    });
    expect(result.isError).not.toBe(true);
    expect(data(result).paymentId).toBe('legacy-implicit');
    expect(elicitation).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('returns a bounded tool error when CSV escaping exceeds the MCP message budget', async () => {
    const { client, fetcher } = await connect();
    fetcher.mockResolvedValue(new Response('"'.repeat(3 * 1024 * 1024)));
    const result = await client.callTool({
      name: 'sb1_export_transactions',
      arguments: { accountKey: 'key', fromDate: '2026-10-01', toDate: '2026-10-25' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('RESPONSE_TOO_LARGE');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
    expect((await client.callTool({ name: 'sb1_auth_status', arguments: {} })).isError).not.toBe(
      true,
    );
  });
  it('keeps an outstanding modern approval valid during concurrent confirmation calls', async () => {
    const { client, fetcher, elicitation } = await connect({
      transfers: true,
      form: true,
      modern: true,
    });
    const preview = data(await client.callTool({ name: 'sb1_preview_transfer', arguments: input }));
    const reply = () => {
      let resolve!: (result: { action: 'accept'; content: { approve: boolean } }) => void;
      const promise = new Promise<{ action: 'accept'; content: { approve: boolean } }>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const firstReply = reply();
    const secondReply = reply();
    elicitation
      .mockImplementationOnce(() => firstReply.promise)
      .mockImplementationOnce(() => secondReply.promise)
      .mockResolvedValue({ action: 'accept', content: { approve: false } });
    fetcher
      .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
      .mockResolvedValueOnce(json({ paymentId: 'first-approved', warnings: [] }));
    const call = { name: 'sb1_confirm_transfer', arguments: { previewId: preview.previewId } };
    const first = client.callTool(call);
    await vi.waitFor(() => expect(elicitation).toHaveBeenCalledTimes(1));
    const second = client.callTool(call);
    await vi.waitFor(() => expect(elicitation).toHaveBeenCalledTimes(2));
    firstReply.resolve({ action: 'accept', content: { approve: true } });
    try {
      const result = await first;
      expect(result.isError).not.toBe(true);
      expect(data(result).paymentId).toBe('first-approved');
      expect(elicitation).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      secondReply.resolve({ action: 'accept', content: { approve: false } });
      expect((await second).isError).toBe(true);
    }
  });
  it.each([true, false])('only submits with explicit legacy form approval=%s', async (approve) => {
    const { client, fetcher, elicitation } = await connect({
      transfers: true,
      form: true,
      approve,
    });
    const preview = data(await client.callTool({ name: 'sb1_preview_transfer', arguments: input }));
    fetcher
      .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
      .mockResolvedValueOnce(json({ paymentId: 'bank-receipt', warnings: [] }));
    const result = await client.callTool({
      name: 'sb1_confirm_transfer',
      arguments: { previewId: preview.previewId },
    });
    expect(elicitation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(elicitation.mock.calls)).toContain('100.00');
    if (approve) {
      expect(data(result)).toMatchObject({ submitted: true, paymentId: 'bank-receipt' });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } else {
      expect(result.isError).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it.each([true, false])('serves modern multi-round-trip approval=%s', async (approve) => {
    const { client, fetcher, elicitation } = await connect({
      transfers: true,
      form: true,
      approve,
      modern: true,
    });
    const preview = data(await client.callTool({ name: 'sb1_preview_transfer', arguments: input }));
    fetcher
      .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
      .mockResolvedValueOnce(json({ paymentId: 'modern-receipt', warnings: [] }));
    const result = await client.callTool({
      name: 'sb1_confirm_transfer',
      arguments: { previewId: preview.previewId },
    });
    expect(elicitation).toHaveBeenCalledTimes(1);
    if (approve) {
      expect(data(result).paymentId).toBe('modern-receipt');
      expect(fetcher).toHaveBeenCalledTimes(3);
    } else {
      expect(result.isError).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('boots the actual stdio executable with a clean stdout protocol stream', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/index.ts')],
      env: { SB1_ACCESS_TOKEN: 'stdio-secret' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0' });
    clients.push(client);
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(11);
    expect(
      JSON.stringify(await client.callTool({ name: 'sb1_auth_status', arguments: {} })),
    ).not.toContain('stdio-secret');
  });
});
