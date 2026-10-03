// 独立写入进程：往同一个数据文件里连续登记多条记录
// 用法：node concurrent-writer.mjs <kind> <dataDir> <workerId> <count>
// kind = regions / places：通过对应的存储类写入
// kind = excl：直接用 JsonFile，在锁内往 excl.log 追加"进入/离开"记录，用来检查同一时间只有一个写入者
import fs from 'node:fs';
import path from 'node:path';
import { RegionStore } from '../../dist/regions.js';
import { PlaceStore } from '../../dist/places.js';
import { JsonFile } from '../../dist/json-file.js';

const [kind, dataDir, worker, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (process.env.MCBOT_LOCK_TIMEOUT_MS) JsonFile.lockTimeoutMs = Number(process.env.MCBOT_LOCK_TIMEOUT_MS);
await new Promise((r) => setTimeout(r, Number(process.env.MCBOT_WRITER_DELAY_MS ?? 300))); // 各进程启动后同时开始

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let i = 0; i < count; i++) {
  const name = `w${worker}-${i}`;
  if (kind === 'regions') {
    const store = new RegionStore(path.join(dataDir, 'regions.json'), 'test-world', `writer${worker}`);
    store.upsert({ name, kind: 'build', dimension: 'overworld', from: { x: i, y: 60, z: Number(worker) }, to: { x: i, y: 61, z: Number(worker) }, source: `writer ${worker}` });
  } else if (kind === 'places') {
    const store = new PlaceStore(path.join(dataDir, 'places.json'), 'test-world', `writer${worker}`);
    store.upsert({ name, kind: 'landmark', dimension: 'overworld', pos: { x: i, y: 64, z: Number(worker) }, source: `writer ${worker}` });
  } else {
    const log = path.join(dataDir, 'excl.log');
    const store = new JsonFile(
      path.join(dataDir, 'regions.json'),
      () => ({ version: 1, regions: [] }),
      (d) => Boolean(d && d.version === 1 && Array.isArray(d.regions))
    );
    store.update((data) => {
      fs.appendFileSync(log, `enter ${name}\n`);
      data.regions.push({ name });
      pause(2);
      fs.appendFileSync(log, `exit ${name}\n`);
    });
  }
}
process.stdout.write('done\n');
