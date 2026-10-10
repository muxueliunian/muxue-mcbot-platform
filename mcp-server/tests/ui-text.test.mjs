import test from 'node:test';
import assert from 'node:assert/strict';
import { BANNED, checkUiText, collect, htmlStrings, jsStrings } from '../../scripts/check-ui-text.mjs';

test('界面文案：取字符串时跳过注释和正则，模板里的表达式另算', () => {
  const src = [
    "// 注释里的口语不算：没装",
    "const a = '已安装', re = /^\"(.*)\"$/, b = `未安装：${x ? '旧版本' : ''}`;",
    "/* 块注释：读不了 */ const c = \"无法读取\";",
  ].join('\n');
  assert.deepEqual(jsStrings(src).map((s) => [s.line, s.text]), [[2, '已安装'], [2, '旧版本'], [2, ''], [2, '未安装：…'], [3, '无法读取']]);
  const html = '<style>.x{}</style><!-- 没装 --><b title="悬停提示">按钮</b>\n<script>const t = \'脚本里\';</script>';
  assert.deepEqual(htmlStrings(html).map((s) => s.text).sort(), ['悬停提示', '按钮', '脚本里'].sort());
});

test('界面文案：禁用词能查出口语写法，书面写法不误报', () => {
  const hit = (text) => checkUiText([{ file: 'x', line: 1, text }]).map((p) => p.word);
  assert.deepEqual(hit('已装好'), ['装好']);
  assert.deepEqual(hit('没装核心模组'), ['没装']);
  assert.deepEqual(hit('文件读不了'), ['读不了']);
  assert.deepEqual(hit('世界开着'), ['开着']);
  assert.deepEqual(hit('马上就好啦'), ['啦']);
  for (const ok of ['已安装', '未安装', '需更新', '世界运行中', '无法读取', '请勿发送给他人', '其他电脑无法连接', '用于测试', '开始新一轮']) assert.deepEqual(hit(ok), [], ok);
  assert.ok(BANNED.length > 20);
});

test('界面文案：WebUI、使用说明和 compat.json 里没有口语用词（规范见 docs/ui_text.md）', () => {
  const items = collect();
  assert.ok(items.length > 400, '取到的文案太少，检查范围可能漏了');
  const problems = checkUiText(items);
  assert.deepEqual(problems.map((p) => `${p.file}:${p.line}「${p.word}」${p.text.slice(0, 40)}`), []);
});
