package com.mcbot.servercontrol.mixin;

import com.mcbot.servercontrol.VirtualConnection;
import net.minecraft.network.Connection;
import net.minecraft.network.PacketSendListener;
import net.minecraft.network.protocol.Packet;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The body has no client, so NeoForge's check that the client negotiated a mod's payload channel cannot pass: mods that
 * greet players with their own packets on login (e.g. Sophisticated Core) would abort the body's login. Packets to the
 * in-process sink are discarded anyway, so they skip that check. Real connections are untouched.
 */
@Mixin(ServerCommonPacketListenerImpl.class)
abstract class VirtualPayloadMixin {
    @Shadow @Final protected Connection connection;

    @Inject(method="send(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketSendListener;)V",at=@At("HEAD"),cancellable=true,require=1)
    private void mcbot$virtualSink(Packet<?> packet,PacketSendListener callback,CallbackInfo ci) {
        if(connection instanceof VirtualConnection virtual) { virtual.send(packet,callback,true); ci.cancel(); }
    }
}
