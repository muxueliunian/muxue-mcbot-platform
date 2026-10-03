// 修正 minecraft-data 里写错的协议定义。要在第一次连服务器（minecraft-protocol 编译协议）之前调用。
//
// 1.21.1：物品组件 potion_contents（药水、喷溅药水、药箭）多了一个 customName 字段，那是 1.21.2 才加的。
// 读到带药水的物品就会读过头（PartialReadError），整个数据包被丢掉：
// 箱子里有药水时开箱等不到内容、一直打不开；背包、掉落物里的药水也会让对应的数据包丢失。
import minecraftData from 'minecraft-data';
import { log } from './logger.js';

type Field = { name?: string; type?: unknown };

// 在协议定义里找到所有 potion_contents: ["container", [...字段]]，去掉 customName
function dropPotionCustomName(node: unknown, path: string, fixed: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => dropPotionCustomName(child, `${path}[${i}]`, fixed));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'potion_contents' && Array.isArray(v) && v[0] === 'container' && Array.isArray(v[1])) {
      const fields = v[1] as Field[];
      const i = fields.findIndex((f) => f?.name === 'customName');
      if (i >= 0) {
        fields.splice(i, 1);
        fixed.push(`${path}.${k}`);
      }
      continue;
    }
    dropPotionCustomName(v, `${path}.${k}`, fixed);
  }
}

let applied = false;

// 返回改了哪些地方（测试用）；重复调用不会重复改
export function applyProtocolFixes(): string[] {
  if (applied) return [];
  applied = true;
  const fixed: string[] = [];
  try {
    const data = minecraftData('1.21.1') as unknown as { protocol?: unknown } | null;
    if (data?.protocol) dropPotionCustomName(data.protocol, '1.21.1', fixed);
  } catch (err) {
    log('warn', `修正协议定义失败：${(err as Error).message ?? err}`);
  }
  if (fixed.length) log('info', `已修正 minecraft-data 协议：1.21.1 的 potion_contents 去掉 customName（${fixed.length} 处）`);
  return fixed;
}
