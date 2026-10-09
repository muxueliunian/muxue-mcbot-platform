package com.mcbot.servercontrol.mixin;

import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** The state a block item would place for a click, worked out by the item itself (wall or standing torch, door hinge...), without placing it. */
@Mixin(BlockItem.class)
public interface BlockItemInvoker {
    @Invoker("getPlacementState") BlockState mcbot$placementState(BlockPlaceContext context);
}
