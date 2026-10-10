package com.mcbot.addon.kaleidoscopecookery;

import com.mcbot.servercontrol.api.McbotApi;
import com.mcbot.servercontrol.api.SeatAdapter;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/**
 * Chairs and cook stools of Kaleidoscope Cookery as MCBOT seats. Only class names are compared (no reflection into the
 * mod, no compile-time dependency), so another version simply is not recognised: {@code installed()} also requires the
 * exact verified version. A seat is taken while a SitEntity overlaps its block, the same test the blocks make themselves.
 */
final class SeatAccess implements SeatAdapter {
    static final String MOD = "kaleidoscope_cookery", VERSION = "1.6.0-neoforge+mc1.21.1";
    static final SeatAccess INSTANCE = new SeatAccess();
    private SeatAccess() {}

    @Override public String id() { return "kaleidoscope_cookery:seat"; }
    @Override public boolean installed() { return McbotApi.versionsMatch(MOD, VERSION); }
    @Override public boolean seat(BlockState state) {
        return SeatRules.seatBlock(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(), state.getBlock().getClass().getName());
    }
    @Override public boolean occupied(ServerLevel level, BlockPos position) {
        return !level.getEntities((Entity) null, new AABB(position), SeatAccess::sitEntity).isEmpty();
    }
    @Override public boolean seatEntity(Entity entity) { return sitEntity(entity); }
    @Override public String hint() { return "kaleidoscope_cookery chairs and cook stools"; }

    private static boolean sitEntity(Entity entity) { return SeatRules.seatEntity(entity.getClass().getName()); }
}
