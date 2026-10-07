package com.mcbot.servercontrol;

import com.mcbot.servercontrol.platform.LoaderPlatform;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.RecipeType;
import net.neoforged.fml.ModList;

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
}
