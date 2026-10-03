package com.mcbot.servercontrol.mixin;

import net.minecraft.server.level.ServerPlayerGameMode;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Read native mining progress; cancellation flags are cleared only after native ABORT. */
@Mixin(ServerPlayerGameMode.class)
public interface ServerPlayerGameModeAccessor {
    @Accessor("gameTicks") int mcbot$gameTicks();
    @Accessor("destroyProgressStart") int mcbot$destroyProgressStart();
    @Accessor("isDestroyingBlock") boolean mcbot$isDestroyingBlock();
    @Accessor("isDestroyingBlock") void mcbot$destroying(boolean value);
    @Accessor("hasDelayedDestroy") boolean mcbot$hasDelayedDestroy();
    @Accessor("hasDelayedDestroy") void mcbot$delayed(boolean value);
}
