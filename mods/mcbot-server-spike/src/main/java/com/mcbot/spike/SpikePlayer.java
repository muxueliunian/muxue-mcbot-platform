package com.mcbot.spike;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;

/** Ordinary survival Player physics, driven once by the world's entity tick. */
final class SpikePlayer extends ServerPlayer {
    long worldTicks;
    long survivalTicks;
    long duplicateSurvivalTicks;
    long movingTicks;
    int lastSurvivalServerTick = Integer.MIN_VALUE;
    int controlExpiresAt;
    long controlDeadlineNanos;
    float forwardInput;

    SpikePlayer(MinecraftServer server, ServerLevel level, GameProfile profile) {
        super(server, level, profile, ClientInformation.createDefault());
    }

    @Override public void tick() {
        worldTicks++;
        super.tick();
        doTick();
        connection.resetPosition();
        serverLevel().getChunkSource().move(this);
    }

    @Override public void doTick() {
        int now = server.getTickCount();
        if (lastSurvivalServerTick == now) {
            duplicateSurvivalTicks++;
            return;
        }
        lastSurvivalServerTick = now;
        if (connection instanceof VirtualGameListener listener) {
            Vec3 motion = listener.takePendingMotion();
            if (motion != null) setDeltaMovement(motion);
        }
        if (now >= controlExpiresAt || System.nanoTime() >= controlDeadlineNanos || !isAlive()) stopInput();
        xxa = 0;
        yya = 0;
        zza = forwardInput;
        if (forwardInput != 0) movingTicks++;
        survivalTicks++;
        Vec3 before = position();
        // Includes Player/LivingEntity ticks, hunger, collision and gravity.
        super.doTick();
        Vec3 displacement = position().subtract(before);
        // Real players do this in handleMovePlayer; no inbound movement packets exist here.
        doCheckFallDamage(displacement.x, displacement.y, displacement.z, onGround());
        setKnownMovement(displacement);
    }

    void moveInput(double x, double z, int ticks) {
        float yaw = (float) Math.toDegrees(Math.atan2(-x, z));
        setYRot(yaw);
        setYHeadRot(yaw);
        forwardInput = 1;
        controlExpiresAt = server.getTickCount() + ticks;
        controlDeadlineNanos = System.nanoTime() + ticks * 50_000_000L;
    }

    void stopInput() {
        forwardInput = 0;
        xxa = yya = zza = 0;
        setJumping(false);
        controlExpiresAt = 0;
        controlDeadlineNanos = 0;
    }
}
