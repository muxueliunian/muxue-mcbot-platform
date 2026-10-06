package com.mcbot.servercontrol;

import io.netty.channel.embedded.EmbeddedChannel;
import net.minecraft.network.*;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.PacketFlow;

/** In-process sink; no network listener or second Minecraft client. */
public final class VirtualConnection extends Connection {
    private final EmbeddedChannel localChannel;
    private PacketListener listener;
    VirtualConnection() { super(PacketFlow.SERVERBOUND); localChannel=new EmbeddedChannel(this); }
    @Override public <T extends PacketListener> void setupInboundProtocol(ProtocolInfo<T> protocol,T listener) { this.listener=listener; }
    @Override public PacketListener getPacketListener() { return listener; }
    void setVirtualListener(PacketListener listener) { this.listener=listener; }
    @Override public boolean isMemoryConnection() { return true; }
    @Override public void send(Packet<?> packet,PacketSendListener callback,boolean flush) { if(callback!=null) callback.onSuccess(); }
    @Override public void flushChannel() { }
    @Override public void tick() { }
    @Override public void disconnect(DisconnectionDetails details) { if(localChannel.isOpen()) localChannel.close(); }
    void closeSink() { localChannel.finishAndReleaseAll(); }
}
