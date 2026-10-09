package com.mcbot.servercontrol;

import com.mcbot.servercontrol.platform.ItemSlots;
import com.mcbot.servercontrol.platform.LoaderPlatform;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.neoforged.fml.ModList;
import net.neoforged.neoforge.capabilities.Capabilities;
import net.neoforged.neoforge.common.CommonHooks;
import net.neoforged.neoforge.common.util.TriState;
import net.neoforged.neoforge.items.IItemHandler;

/** NeoForge side of {@link LoaderPlatform}; a loader file (allowed to use net.neoforged). */
final class NeoForgePlatform implements LoaderPlatform {
    static final NeoForgePlatform INSTANCE=new NeoForgePlatform();
    private NeoForgePlatform() {}
    public String loader() {return "neoforge";}
    public String loaderModId() {return "neoforge";}
    public String modVersion(String modId) {
        ModList list=ModList.get();
        return list==null?"":list.getModContainerById(modId).map(c->c.getModInfo().getVersion().toString()).orElse("");
    }
    public int burnTime(ItemStack stack,RecipeType<?> type) {return stack.isEmpty()?0:stack.getBurnTime(type);}
    public ItemSlots itemSlots(ServerLevel level,BlockPos position,BlockState state,BlockEntity entity,Direction side) {
        IItemHandler handler=level.getCapability(Capabilities.ItemHandler.BLOCK,position,state,entity,side);
        return handler==null?null:new ItemSlots() {
            public int size() {return handler.getSlots();}
            public ItemStack get(int slot) {return handler.getStackInSlot(slot);}
            public int limit(int slot) {return handler.getSlotLimit(slot);}
            public boolean valid(int slot,ItemStack stack) {return handler.isItemValid(slot,stack);}
            public ItemStack insert(int slot,ItemStack stack,boolean simulate) {return handler.insertItem(slot,stack,simulate);}
            public ItemStack extract(int slot,int amount,boolean simulate) {return handler.extractItem(slot,amount,simulate);}
        };
    }
    // Same gates as a right-click on the block: spawn protection and world border, then the event protection mods cancel.
    public boolean mayUseBlock(ServerPlayer player,BlockHitResult hit) {
        if(!player.serverLevel().mayInteract(player,hit.getBlockPos())) return false;
        var event=CommonHooks.onRightClickBlock(player,InteractionHand.MAIN_HAND,hit.getBlockPos(),hit);
        return !event.isCanceled()&&event.getUseBlock()!=TriState.FALSE;
    }
}
