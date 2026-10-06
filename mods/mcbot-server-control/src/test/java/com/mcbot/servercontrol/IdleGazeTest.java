package com.mcbot.servercontrol;

import net.minecraft.world.phys.Vec3;

/** Turning rules of the idle head movement, without a world. */
final class IdleGazeTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static boolean near(float a,float b){return Math.abs(a-b)<0.01;}
    static void run(){
        check(near(IdleGaze.yawTo(new Vec3(0,0,1)),0),"Facing +Z is yaw 0");
        check(near(IdleGaze.yawTo(new Vec3(-1,0,0)),90),"Facing -X is yaw 90");
        check(near(IdleGaze.yawTo(new Vec3(1,0,0)),-90),"Facing +X is yaw -90");
        check(near(IdleGaze.pitchTo(new Vec3(1,1,0)),-45),"Looking up is negative pitch");
        check(near(IdleGaze.pitchTo(new Vec3(0,0,3)),0),"Level target is pitch 0");
        check(near(IdleGaze.approach(0,30,12),12),"Turns at most one step per tick");
        check(near(IdleGaze.approach(0,5,12),5),"Small difference is reached at once");
        check(near(IdleGaze.approach(170,-170,12),182),"Takes the short way across the -180/180 seam");
        check(near(IdleGaze.approach(-170,170,12),-182),"Short way the other direction too");
        check(near(IdleGaze.approach(720,0,12),720),"Whole turns already face the target");
        System.out.println("IdleGazeTest: "+checks+" checks passed");
    }
}
