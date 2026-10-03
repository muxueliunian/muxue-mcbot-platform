package com.mcbot.servercontrol;

import java.util.UUID;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.level.BlockEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import static com.mcbot.servercontrol.Protocol.obj;

/** Disabled by default; isolated tests can change a physical marker through their fixture setup. */
final class ValidationProtection implements AutoCloseable {
    private final boolean enabled=Boolean.getBoolean("mcbot.validationFixture");
    private final UUID uuid;
    private static final BlockPos TARGET=new BlockPos(516,201,512), MARKER=new BlockPos(516,199,512);
    private long breakCancelled,placeCancelled,rightClickCancelled;
    ValidationProtection(UUID uuid) { this.uuid=uuid; if(enabled) NeoForge.EVENT_BUS.register(this); }
    @SubscribeEvent public void breakBlock(BlockEvent.BreakEvent event) {
        if(uuid.equals(event.getPlayer().getUUID())&&event.getPos().equals(TARGET)&&event.getLevel().getBlockState(MARKER).is(Blocks.REDSTONE_BLOCK)) { event.setCanceled(true); breakCancelled++; }
    }
    @SubscribeEvent public void placeBlock(BlockEvent.EntityPlaceEvent event) {
        if(event.getEntity()!=null&&uuid.equals(event.getEntity().getUUID())&&event.getPos().equals(TARGET)&&event.getLevel().getBlockState(MARKER).is(Blocks.GOLD_BLOCK)) { event.setCanceled(true); placeCancelled++; }
    }
    @SubscribeEvent public void rightClick(PlayerInteractEvent.RightClickBlock event) {
        boolean target=event.getPos().equals(TARGET)||(event.getFace()!=null&&event.getPos().relative(event.getFace()).equals(TARGET));
        if(uuid.equals(event.getEntity().getUUID())&&target&&event.getLevel().getBlockState(MARKER).is(Blocks.DIAMOND_BLOCK)) { event.setCanceled(true); rightClickCancelled++; }
    }
    boolean enabled() { return enabled; }
    JsonObject json() { return obj("enabled",enabled,"breakCancelled",breakCancelled,"placeCancelled",placeCancelled,"rightClickCancelled",rightClickCancelled); }
    @Override public void close() { if(enabled) NeoForge.EVENT_BUS.unregister(this); }
}
