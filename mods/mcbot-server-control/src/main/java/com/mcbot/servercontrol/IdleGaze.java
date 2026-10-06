package com.mcbot.servercontrol;

import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.util.RandomSource;
import net.minecraft.world.phys.Vec3;

/**
 * Head movement while the body stands still, so it does not stare frozen in one direction:
 * turn to whoever just spoke, otherwise watch the nearest visible player, otherwise glance around now and then.
 * Only rotation changes; it never moves the body or touches its inventory, and runs only when no action aims the body
 * (and for a few seconds after one, so an explicit look-at is not undone at once).
 */
final class IdleGaze {
    static final double WATCH_RANGE=8,SPEAKER_RANGE=16;
    static final long SPEAKER_MS=4000,HOLD_AFTER_ACTION_MS=3000;
    static final float TURN_PER_TICK=12;
    private final RandomSource random=RandomSource.create();
    private float glanceYaw,glancePitch;
    private long nextGlance;

    void tick(BodyPlayer body,ServerPlayer speaker,long spokeAt,long now){
        if(!body.isAlive()||body.isSleeping()||body.isPassenger())return;
        Vec3 eye=body.getEyePosition();ServerPlayer watched=null;
        if(speaker!=null&&now-spokeAt<SPEAKER_MS&&usable(body,speaker,SPEAKER_RANGE))watched=speaker;
        if(watched==null)for(ServerPlayer other:body.serverLevel().players())
            if(usable(body,other,WATCH_RANGE)&&(watched==null||other.distanceToSqr(body)<watched.distanceToSqr(body)))watched=other;
        float yaw,pitch;
        if(watched!=null){
            Vec3 delta=watched.getEyePosition().subtract(eye);
            yaw=yawTo(delta);pitch=pitchTo(delta);nextGlance=now+2000+random.nextInt(3000);
        } else {
            if(now>=nextGlance){
                glanceYaw=body.getYRot()+(random.nextFloat()-0.5f)*120;glancePitch=-10+random.nextFloat()*25;
                nextGlance=now+4000+random.nextInt(5000);
            }
            yaw=glanceYaw;pitch=glancePitch;
        }
        float nextYaw=approach(body.getYHeadRot(),yaw,TURN_PER_TICK),nextPitch=approach(body.getXRot(),pitch,TURN_PER_TICK*0.6f);
        body.setYRot(nextYaw);body.setYHeadRot(nextYaw);body.setYBodyRot(nextYaw);body.setXRot(Mth.clamp(nextPitch,-90,90));
    }
    private static boolean usable(BodyPlayer body,ServerPlayer other,double range){
        return other!=body&&!(other instanceof BodyPlayer)&&other.isAlive()&&!other.isSpectator()&&other.level()==body.level()
            &&other.distanceToSqr(body)<=range*range&&body.hasLineOfSight(other);
    }
    static float yawTo(Vec3 delta){return (float)Math.toDegrees(Math.atan2(-delta.x,delta.z));}
    static float pitchTo(Vec3 delta){return (float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance()));}
    /** Turn from current toward target by at most step degrees, the short way round. */
    static float approach(float current,float target,float step){
        float diff=Mth.wrapDegrees(target-current);
        return current+Mth.clamp(diff,-step,step);
    }
}
