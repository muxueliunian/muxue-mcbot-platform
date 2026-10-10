#!/usr/bin/env node
// 核对 compat.json 和各模组代码里锁的版本是否一致：平台版本、jar 名、被适配模组的 mod id 和确切版本。
// 用法：node scripts/check-compat.mjs [compat.json]；有不一致时列出来并以 1 退出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadCompat(file = path.join(root, 'compat.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function javaSources(dir) {
  const out = [];
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.java')) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.join('\n');
}

function gradleProperty(project, key) {
  const file = path.join(root, project, 'gradle.properties');
  if (!fs.existsSync(file)) return undefined;
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find(l => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

function jarName(project) {
  const name = path.basename(project);
  const version = gradleProperty(project, 'mod_version');
  return version ? `${name}-${version}.jar` : undefined;
}

export function checkCompat(compat) {
  const problems = [];
  const core = compat.core;
  const api = javaSources(path.join(root, core.project, 'src/main/java/com/mcbot/servercontrol/api'));
  const pinned = /MINECRAFT\s*=\s*"([^"]+)"\s*,\s*NEOFORGE\s*=\s*"([^"]+)"/.exec(api);
  if (!pinned) problems.push('McbotApi 里找不到 MINECRAFT / NEOFORGE');
  else {
    if (pinned[1] !== compat.platform.minecraft) problems.push(`Minecraft：清单 ${compat.platform.minecraft}，McbotApi ${pinned[1]}`);
    if (pinned[2] !== compat.platform.loaderMin) problems.push(`NeoForge 最低版本：清单 ${compat.platform.loaderMin}，McbotApi ${pinned[2]}`);
  }
  for (const project of [core.project, ...compat.adapters.filter(a => a.kind === 'addon').map(a => a.project)]) {
    const range = /modId="neoforge"[\s\S]*?versionRange="\[([^,\]]+),\)"/.exec(fs.readFileSync(path.join(root, project, 'src/main/templates/META-INF/neoforge.mods.toml'), 'utf8'));
    if (range?.[1] !== compat.platform.loaderMin) problems.push(`${project}：neoforge.mods.toml 的 NeoForge 下限是 ${range?.[1]}，清单 ${compat.platform.loaderMin}`);
  }
  if (jarName(core.project) !== core.jar) problems.push(`核心 jar：清单 ${core.jar}，构建出来是 ${jarName(core.project)}`);
  const ids = new Set();
  for (const adapter of compat.adapters) {
    if (ids.has(adapter.id)) problems.push(`适配 id 重复：${adapter.id}`);
    ids.add(adapter.id);
    if (!['addon', 'config'].includes(adapter.kind)) problems.push(`${adapter.id}：未知的 kind ${adapter.kind}`);
    if (adapter.kind === 'addon' && jarName(adapter.project) !== adapter.jar) problems.push(`${adapter.id}：清单 jar ${adapter.jar}，构建出来是 ${jarName(adapter.project)}`);
    const sources = adapter.project ? javaSources(path.join(root, adapter.project, 'src/main/java')) : '';
    for (const need of adapter.requires ?? []) {
      if (need.ref) {
        if (!compat.adapters.some(a => a.id === need.ref)) problems.push(`${adapter.id}：引用了不存在的适配 ${need.ref}`);
        continue;
      }
      if (!sources.includes(`"${need.modId}"`)) problems.push(`${adapter.id}：代码里没有 mod id "${need.modId}"`);
      if (!sources.includes(`"${need.version}"`)) problems.push(`${adapter.id}：代码里没有锁 ${need.modId} 的版本 "${need.version}"`);
      const m = need.modrinth;
      if (!m || !/^https:\/\/cdn\.modrinth\.com\//.test(m.url ?? '') || !m.file || !(m.size > 0)) problems.push(`${adapter.id}：${need.modId} 缺官方下载信息（Modrinth 的 url、文件名、大小）`);
    }
    if (adapter.kind === 'config') {
      for (const [mod, version] of Object.entries(adapter.config?.mods ?? {})) {
        const target = compat.adapters.flatMap(a => a.requires ?? []).find(r => r.modId === mod);
        if (!target) problems.push(`${adapter.id}：配置开启的 ${mod} 在清单里没有下载信息`);
        else if (target.version !== version) problems.push(`${adapter.id}：配置写 ${mod} ${version}，清单下载的是 ${target.version}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const compat = loadCompat(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  const problems = checkCompat(compat);
  if (problems.length) {
    console.error(`compat.json 和代码对不上（${problems.length} 处）：`);
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log(`compat.json 和代码一致：MC ${compat.platform.minecraft}，NeoForge ${compat.platform.loaderMin} 及以上，${compat.adapters.length} 个适配`);
}
