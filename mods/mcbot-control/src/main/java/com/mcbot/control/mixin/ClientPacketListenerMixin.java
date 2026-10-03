package com.mcbot.control.mixin;

import com.mcbot.control.McbotControl;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundSectionBlocksUpdatePacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** TAIL runs only after PacketUtils has moved handling to the client thread. No packet interception. */
@Mixin(ClientPacketListener.class)
abstract class ClientPacketListenerMixin {
    @Inject(method="handleBlockUpdate",at=@At("TAIL"))
    private void mcbot$serverBlock(ClientboundBlockUpdatePacket packet,CallbackInfo callback) {
        McbotControl.serverBlock((ClientPacketListener)(Object)this,packet.getPos(),packet.getBlockState());
    }
    @Inject(method="handleChunkBlocksUpdate",at=@At("TAIL"))
    private void mcbot$serverBlocks(ClientboundSectionBlocksUpdatePacket packet,CallbackInfo callback) {
        packet.runUpdates((pos,state)->McbotControl.serverBlock((ClientPacketListener)(Object)this,pos,state));
    }
}
