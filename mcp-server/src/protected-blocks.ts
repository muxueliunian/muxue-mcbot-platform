// 默认不破坏的功能性方块（mine-blocks / build / 寻路共用），防止拆掉玩家的东西

export const PROTECTED = /(chest|barrel|shulker_box|_bed$|furnace|smoker|crafting_table|door|_sign$|anvil|enchanting_table|brewing_stand|beacon|hopper|dispenser|dropper|lectern|jukebox|note_block|respawn_anchor|lodestone|spawner|portal|torch|lantern|campfire|_banner$|bookshelf|ender_chest|item_frame|glass)/;

// 只对寻路额外保护的建材：寻路挖路时不能在房子墙上开洞（mine-blocks / build 明确指定时仍可挖）
export const BUILDING = /(_planks|_stairs|_slab|_fence|_fence_gate|_wall|_bricks|^bricks|cobblestone|_wool|_carpet|_terracotta|_concrete|ladder|hay_block|_log|_wood)$|^(smooth|polished|stripped|cut)_/;

// 让寻路在挖路时绕开这些方块
export function protectFromPathfinder(movements: unknown, mcData: { blocksArray: { id: number; name: string }[] }): void {
  const set = (movements as { blocksCantBreak: Set<number> }).blocksCantBreak;
  for (const b of mcData.blocksArray) {
    if (PROTECTED.test(b.name) || BUILDING.test(b.name)) set.add(b.id);
  }
}
