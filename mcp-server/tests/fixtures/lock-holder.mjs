// 拿到数据文件的锁后长时间不放（模拟一次很慢但仍然活着的写入）
// 用法：node lock-holder.mjs <file> <holdMs> <readyFile>
import fs from 'node:fs';
import { JsonFile } from '../../dist/json-file.js';

const [file, holdArg, readyFile] = process.argv.slice(2);
const holdMs = Number(holdArg);
const store = new JsonFile(
  file,
  () => ({ version: 1, regions: [] }),
  (d) => Boolean(d && d.version === 1 && Array.isArray(d.regions))
);
store.update((data) => {
  data.regions.push({ name: 'from-holder' });
  fs.writeFileSync(readyFile, 'locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
});
process.stdout.write('done\n');
