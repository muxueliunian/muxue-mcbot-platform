package com.mcbot.servercontrol.platform;

import java.util.Objects;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.RecipeType;

/**
 * The few things the server body needs from the mod loader. Everything else in the mod uses vanilla classes only
 * (enforced by the loaderNeutralCheck build task), so a Fabric build only has to supply this and the event bridge.
 * The loader entry point installs its implementation before any server starts.
 */
public interface LoaderPlatform {
    /** Loader name: "neoforge", "fabric". */
    String loader();

    /** Mod id under which the loader reports its own version ("neoforge", "fabricloader"). */
    String loaderModId();

    /** Installed version of a mod, or "" when it is absent. */
    String modVersion(String modId);

    /** Burn time of a fuel stack in ticks for a cooking recipe type; 0 when it is not a fuel. */
    int burnTime(ItemStack stack, RecipeType<?> type);

    static LoaderPlatform get() {
        LoaderPlatform platform = Holder.current;
        if (platform == null) throw new IllegalStateException("No loader platform installed");
        return platform;
    }

    /** Null before the loader entry point ran (early add-on constructors, offline tests). */
    static LoaderPlatform installedOrNull() { return Holder.current; }

    static void install(LoaderPlatform platform) { Holder.current = Objects.requireNonNull(platform, "platform"); }

    final class Holder {
        private static volatile LoaderPlatform current;
        private Holder() {}
    }
}
