package com.mcbot.servercontrol;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.*;
import net.minecraft.world.phys.Vec3;

/** Survival tick follows the validated spike, with lease checked before physics. */
final class BodyPlayer extends ServerPlayer {
    private final ServerController controller;
    private int lastSurvivalTick=Integer.MIN_VALUE;
    float forwardInput;
    private boolean jumpInput;
    BodyPlayer(MinecraftServer server,ServerLevel level,GameProfile profile,ServerController controller) {
        this(server,level,profile,ClientInformation.createDefault(),controller);
    }
    private BodyPlayer(MinecraftServer server,ServerLevel level,GameProfile profile,ClientInformation information,ServerController controller) {
        super(server,level,profile,information); this.controller=controller;
    }
    BodyPlayer createRespawnReplacement(MinecraftServer server,ServerLevel level,GameProfile profile,ClientInformation information) {
        return new BodyPlayer(server,level,profile,information,controller);
    }
    @Override public void tick() {
        controller.beforePhysics(this);
        super.tick(); doTick();
        pumpLocalTransport();
    }
    /** Chunk ticket migration must run even before this entity's destination chunk can tick. */
    void pumpLocalTransport() {
        if(connection instanceof VirtualGameListener listener) listener.acknowledgeTeleport();
        connection.resetPosition();
        serverLevel().getChunkSource().move(this);
    }
    @Override public void doTick() {
        int now=server.getTickCount();
        if(lastSurvivalTick==now) return;
        lastSurvivalTick=now;
        controller.beforePhysics(this);
        if(connection instanceof VirtualGameListener listener) {
            listener.acknowledgeTeleport();
            Vec3 motion=listener.takePendingMotion();
            if(motion!=null) setDeltaMovement(motion);
        }
        xxa=yya=0; zza=forwardInput;setJumping(jumpInput);
        Vec3 before=position();
        super.doTick();
        Vec3 displacement=position().subtract(before);
        doCheckFallDamage(displacement.x,displacement.y,displacement.z,onGround());
        setKnownMovement(displacement);
    }
    void moveInput(double x,double z) {
        moveInput(x,z,1);
    }
    void moveInput(double x,double z,float strength) {
        float yaw=(float)Math.toDegrees(Math.atan2(-x,z));
        setYRot(yaw); setYHeadRot(yaw); forwardInput=Math.max(0,Math.min(1,strength));
    }
    void jumpInput(boolean jump) {jumpInput=jump;setJumping(jump);}
    /**
     * Let go of everything, except what a player does without thinking in water: keep the head above it. With the eyes
     * under water the body holds jump and floats up instead of sinking to the bottom and drowning while it waits.
     */
    void stopInput() { forwardInput=0; jumpInput=isUnderWater();xxa=yya=zza=0; setJumping(jumpInput); setSprinting(false); }
    /** Sprint like a player: only running forward on foot with more than three drumsticks and nothing in use. */
    void sprintInput(boolean sprint) { setSprinting(sprint&&forwardInput>=1&&!isInWater()&&!isUsingItem()&&getFoodData().getFoodLevel()>6); }
}
