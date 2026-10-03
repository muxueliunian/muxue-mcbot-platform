package com.mcbot.control.mixin;

import com.mcbot.control.McbotControl;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Prevent vanilla's unfocused mouse path from aborting our one explicitly targeted dig. */
@Mixin(Minecraft.class)
abstract class MinecraftAttackMixin {
    @Inject(method="continueAttack",at=@At("HEAD"),cancellable=true)
    private void mcbot$controlledDig(boolean leftClick,CallbackInfo callback) {
        if(McbotControl.suppressVanillaAttack()) callback.cancel();
    }
}
