package com.mcbot.servercontrol.api.workstation;

import java.util.List;
import net.minecraft.world.item.ItemStack;

/**
 * What a working machine holds and how far along it is, read from the block itself without opening its menu, so the
 * bot can load a machine, leave, and know when to come back ({@link WorkstationAdapter#progress}).
 *
 * @param inputs    what is still waiting to be processed (copies; empty stacks left out)
 * @param results   finished products waiting to be taken (copies)
 * @param fuel      fuel still in its slot (copy), or {@link ItemStack#EMPTY}
 * @param working   whether it is processing right now (a lit furnace, a brewing stand mid-brew)
 * @param ticksLeft game ticks until everything queued is done if it keeps working; -1 when unknown
 * @param fuelTicks game ticks of work the fuel inside (burning plus in the slot) still covers; -1 when unknown or not fuelled
 */
public record StationProgress(List<ItemStack> inputs, List<ItemStack> results, ItemStack fuel, boolean working, int ticksLeft, int fuelTicks) {
    public StationProgress {
        inputs = inputs.stream().filter(s -> !s.isEmpty()).map(ItemStack::copy).toList();
        results = results.stream().filter(s -> !s.isEmpty()).map(ItemStack::copy).toList();
        fuel = fuel.copy();
    }
}
