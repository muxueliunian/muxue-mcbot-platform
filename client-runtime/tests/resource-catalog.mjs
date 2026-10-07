// What the server reports for the vanilla blocks the tests use: kind by block tags and drops rolled from the loot table.
const ores = { coal: ['minecraft:coal', 1], iron: ['minecraft:raw_iron', 1], copper: ['minecraft:raw_copper', 2], diamond: ['minecraft:diamond', 1] };
const silkDrops = { 'minecraft:stone': 'minecraft:cobblestone', 'minecraft:deepslate': 'minecraft:cobbled_deepslate' };
export function resourceOf(id) {
  const ore = /^[a-z0-9_.-]+:(?:deepslate_)?([a-z]+)_ore$/.exec(id);
  if (ore) {
    const [item, least] = ores[ore[1]] ?? [id, 1];
    return { kind: 'ore', drops: [{ item, preference: 'no_silk_touch', least }] };
  }
  if (/_(log|stem)$/.test(id)) return { kind: 'log', drops: [{ item: id, preference: 'any', least: 1 }] };
  if (silkDrops[id]) return { kind: 'stone', drops: [{ item: silkDrops[id], preference: 'no_silk_touch', least: 1 }, { item: id, preference: 'silk_touch', least: 1 }] };
  return { kind: 'stone', drops: [{ item: id, preference: 'any', least: 1 }] };
}
