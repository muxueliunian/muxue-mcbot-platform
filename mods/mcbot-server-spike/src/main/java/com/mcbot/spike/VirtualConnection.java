package com.mcbot.spike;

import io.netty.channel.embedded.EmbeddedChannel;
import net.minecraft.network.Connection;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.PacketListener;
import net.minecraft.network.PacketSendListener;
import net.minecraft.network.ProtocolInfo;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.PacketFlow;

/** An in-process packet sink, never registered with ServerConnectionListener. */
final class VirtualConnection extends Connection {
    private final EmbeddedChannel localChannel;
    private PacketListener listener;
    long discardedPackets;

    VirtualConnection() {
        super(PacketFlow.SERVERBOUND);
        localChannel = new EmbeddedChannel(this);
    }

    @Override public <T extends PacketListener> void setupInboundProtocol(ProtocolInfo<T> protocol, T listener) {
        this.listener = listener;
    }
    @Override public PacketListener getPacketListener() { return listener; }
    void setVirtualListener(PacketListener listener) { this.listener = listener; }
    @Override public boolean isMemoryConnection() { return true; }
    @Override public void send(Packet<?> packet, PacketSendListener callback, boolean flush) {
        discardedPackets++;
        if (callback != null) callback.onSuccess();
    }
    @Override public void flushChannel() { }
    @Override public void tick() { }
    @Override public void disconnect(DisconnectionDetails details) {
        if (localChannel != null && localChannel.isOpen()) localChannel.close();
    }
    void closeSink() { localChannel.finishAndReleaseAll(); }
}
