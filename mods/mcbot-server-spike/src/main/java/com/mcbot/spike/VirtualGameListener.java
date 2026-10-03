package com.mcbot.spike;

import net.minecraft.network.PacketSendListener;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundSetEntityMotionPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.phys.Vec3;

/** Local motion delivery only; no network position reconciliation. */
final class VirtualGameListener extends ServerGamePacketListenerImpl {
    private final VirtualConnection sink;
    private Vec3 pendingMotion;
    long ownMotionPacketsQueued;
    long ownMotionPacketsConsumed;

    VirtualGameListener(MinecraftServer server, VirtualConnection sink, SpikePlayer player, CommonListenerCookie cookie) {
        super(server, sink, player, cookie);
        this.sink = sink;
    }

    @Override public void tick() { }
    @Override public void send(Packet<?> packet, PacketSendListener callback) {
        if (packet instanceof ClientboundSetEntityMotionPacket motion && motion.getId() == player.getId()) {
            // Player.attack restores the old delta after send returns, so delivery must wait.
            // These packets contain absolute velocity: the latest replaces, never adds.
            pendingMotion = new Vec3(motion.getXa(), motion.getYa(), motion.getZa());
            ownMotionPacketsQueued++;
        }
        // Client-only packets have no consumer. Do not represent this as Mod GUI support.
        sink.send(packet, callback, true);
    }

    Vec3 takePendingMotion() {
        Vec3 motion = pendingMotion;
        pendingMotion = null;
        if (motion != null) ownMotionPacketsConsumed++;
        return motion;
    }

    boolean hasPendingMotion() { return pendingMotion != null; }

    void clearPendingMotion() { pendingMotion = null; }
}
