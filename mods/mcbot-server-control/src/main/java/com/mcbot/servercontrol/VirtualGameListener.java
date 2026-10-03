package com.mcbot.servercontrol;

import net.minecraft.network.PacketSendListener;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.*;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.*;
import net.minecraft.world.phys.Vec3;

final class VirtualGameListener extends ServerGamePacketListenerImpl {
    private final VirtualConnection sink;
    private Vec3 pendingMotion;
    private Integer pendingTeleport;
    VirtualGameListener(MinecraftServer server,VirtualConnection sink,BodyPlayer player,CommonListenerCookie cookie) {
        super(server,sink,player,cookie); this.sink=sink;
    }
    @Override public void tick() { acknowledgeTeleport(); }
    @Override public void send(Packet<?> packet,PacketSendListener callback) {
        if(packet instanceof ClientboundSetEntityMotionPacket motion&&motion.getId()==player.getId())
            pendingMotion=new Vec3(motion.getXa(),motion.getYa(),motion.getZa());
        if(packet instanceof ClientboundPlayerPositionPacket teleport) pendingTeleport=teleport.getId();
        sink.send(packet,callback,true);
    }
    void acknowledgeTeleport() {
        if(pendingTeleport!=null) { int id=pendingTeleport; pendingTeleport=null; handleAcceptTeleportPacket(new ServerboundAcceptTeleportationPacket(id)); }
    }
    Vec3 takePendingMotion() { Vec3 result=pendingMotion; pendingMotion=null; return result; }
    void clearPendingMotion() { pendingMotion=null; }
}
