package com.mcbot.servercontrol;

import net.minecraft.world.phys.Vec3;

/** Grounded driving geometry; support can be on the native sole edge during a stair step. */
final class GroundNavigation {
    interface View {
        boolean clear(Vec3 from,Vec3 to);
        boolean contact(Vec3 feet);
        boolean stand(Vec3 feet);
        boolean supportSweep(Vec3 from,Vec3 to,double low,double high);
    }
    record Step(Vec3 from,double rise,boolean allowed){}
    static Step check(Vec3 plannedStart,Vec3 feet,Vec3 next,View view){
        if(plannedStart==null)return new Step(feet,0,false);
        Vec3 from=feet;
        double rise=next.y-from.y;
        boolean allowed=from.subtract(next).horizontalDistance()<=1.25&&rise<=1.05&&rise>=-2.5&&view.contact(from)&&view.stand(next);
        if(allowed){
            double y=rise>0.6?from.y+1.25:Math.max(from.y,next.y);
            Vec3 highFrom=new Vec3(from.x,y,from.z),highNext=new Vec3(next.x,y,next.z);
            allowed=view.clear(from,highFrom)&&view.clear(highFrom,highNext)&&view.clear(highNext,next);
        }
        if(allowed&&rise>=-0.001&&rise<=0.6)allowed=view.supportSweep(from,next,from.y,Math.max(from.y,next.y));
        return new Step(from,rise,allowed);
    }
    static boolean dropClear(Vec3 feet,Vec3 next,View view){
        if(feet.y-next.y<0||feet.y-next.y>2.5||!view.stand(next))return false;
        Vec3 above=new Vec3(next.x,feet.y,next.z);
        return view.clear(feet,above)&&view.clear(above,next);
    }
}
