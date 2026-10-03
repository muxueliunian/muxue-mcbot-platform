// 测试用 MCP 服务端：和 main.ts 一样先加载 stdio-guard，再故意往 stdout 写各种"像协议"的日志。
// 不创建 Minecraft Bot
import { protocolStdout } from '../../dist/stdio-guard.js';
import './noisy-module.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ToolFactory } from '../../dist/tool-factory.js';

const server = new McpServer({ name: 'stdio-fixture', version: '0.0.0' });
const connection = {
  checkConnectionAndReconnect: async () => ({ connected: true }),
  isConnected: () => true,
  getBot: () => null,
};
const factory = new ToolFactory(server, connection);

function noise(tag) {
  console.log(`{"jsonrpc":"2.0","id":999,"result":{"fake":"${tag}"}}`);
  console.log(`${new Date().toISOString()} fake timestamp log ${tag}`);
  console.info('multi\nline\n{ "not": "protocol" }');
  process.stdout.write(Buffer.from(`\n{"raw":"buffer ${tag}"}\n`));
  process.stdout.write(`callback write ${tag}\n`, () => console.error(`callback fired ${tag}`));
  console.error(`real error ${tag}`);
}

factory.registerTool('noisy', 'writes noise then returns text', { tag: z.string() }, async ({ tag }) => {
  noise(tag);
  return factory.createResponse(`noisy done ${tag}`);
});

factory.registerTool('image', 'returns a PNG of the requested size', { bytes: z.number().int() }, async ({ bytes }) => {
  noise('image');
  const png = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  for (let i = 8; i < bytes; i++) png[i] = (i * 31 + 7) & 0xff;
  return factory.createImageResponse(png, 'image/png', `png ${bytes}`);
});

factory.registerTool('fails', 'always fails', {}, async () => {
  throw new Error('boom');
});

await server.connect(new StdioServerTransport(process.stdin, protocolStdout));
console.log('{"jsonrpc":"2.0","method":"fake/after-connect"}');
