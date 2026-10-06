#!/usr/bin/env node
// 第 8 步示例适配② 的存档夹具：服务器停止时，往隔离服存档的 Sophisticated Backpacks 存储
// （world/data/sophisticatedbackpacks.dat）写入几只固定 UUID 的背包内容。升级只能通过背包界面装，命令改不了，
// 所以测试用的升级在这里预先写好。只用于隔离服；运行前先备份存档，测完用备份还原。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nbt = createRequire(path.join(root, 'mcp-server/package.json'))('prismarine-nbt');
if (!process.argv.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-backpack-fixture.mjs --allow-fixture');
  process.exit(1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const lock = path.join(serverDir, 'world/session.lock');
if (fs.existsSync(lock)) { try { fs.closeSync(fs.openSync(lock, 'r+')); } catch { throw Error('服务器好像还在运行，先停服'); } }
const file = path.join(serverDir, 'world/data/sophisticatedbackpacks.dat');
assert(!fs.existsSync(file), '存档里已经有 sophisticatedbackpacks.dat，先用备份还原再写夹具');

const BACKPACKS = {
  pickup: '6d63626f-7400-4000-8000-000000000001', // 拾取升级（默认空黑名单＝什么都捡）
  stocked: '6d63626f-7400-4000-8000-000000000002', // 预放 8 圆石、3 橡木原木，放在地上当容器
  stacked: '6d63626f-7400-4000-8000-000000000003', // 堆叠升级：MCBOT 没验证，应拒绝
  voided: '6d63626f-7400-4000-8000-000000000004', // 铁背包，拾取＋销毁升级：销毁升级没验证，打开会被拒绝
};
const ints = uuid => { const hex = uuid.replaceAll('-', ''); return [0, 8, 16, 24].map(i => (parseInt(hex.slice(i, i + 8), 16) | 0)); };
const item = (slot, id, count) => ({ Slot: nbt.int(slot), id: nbt.string(id), count: nbt.int(count) });
const handler = (size, items) => nbt.comp({ Size: nbt.int(size), Items: nbt.list(items.length ? nbt.comp(items) : { type: 'end', value: [] }) });
const entry = (uuid, inventory, upgrades) => ({
  uuid: { type: 'intArray', value: ints(uuid) },
  contents: nbt.comp({ inventory: handler(27, inventory), upgradeInventory: handler(Math.max(1, upgrades.length), upgrades) }),
});
const entries = [
  entry(BACKPACKS.pickup, [], [item(0, 'sophisticatedbackpacks:pickup_upgrade', 1)]),
  entry(BACKPACKS.stocked, [item(0, 'minecraft:cobblestone', 8), item(1, 'minecraft:oak_log', 3)], []),
  entry(BACKPACKS.stacked, [], [item(0, 'sophisticatedbackpacks:stack_upgrade_tier_1', 1)]),
  entry(BACKPACKS.voided, [], [item(0, 'sophisticatedbackpacks:pickup_upgrade', 1), item(1, 'sophisticatedbackpacks:void_upgrade', 1)]),
];
const data = nbt.comp({
  DataVersion: nbt.int(3955),
  data: nbt.comp({ backpackContents: nbt.list(nbt.comp(entries)), accessLogRecords: nbt.list({ type: 'end', value: [] }) }),
}, '');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, zlib.gzipSync(nbt.writeUncompressed(data, 'big')));
console.log(`写入 ${path.relative(serverDir, file)}：${Object.entries(BACKPACKS).map(([k, v]) => `${k}=${v}`).join(', ')}`);
