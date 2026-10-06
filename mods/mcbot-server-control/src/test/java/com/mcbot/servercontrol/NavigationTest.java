package com.mcbot.servercontrol;

import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.Shapes;

/** Waypoint and steering rules of the vanilla-route driver, plus native shape facts, without a world. */
final class NavigationTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    static void run(){
        Vec3 node=new Vec3(10.5,64,-3.5);
        check(NativeNavigation.reached(new Vec3(10.9,64,-3.1),node),"Inside the 0.45 waypoint square counts as reached");
        check(!NativeNavigation.reached(new Vec3(11.0,64,-3.5),node),"Half a block off the node centre is not reached yet");
        check(NativeNavigation.reached(new Vec3(10.5,64.9,-3.5),node),"Standing on a slab or snow layer above the node still reaches it");
        check(!NativeNavigation.reached(new Vec3(10.5,65,-3.5),node),"A whole block above the node is a different node");
        check(NativeNavigation.reached(new Vec3(10.5,63.2,-3.5),node),"Mid-jump below the node still reaches it");

        var stepUp=NativeNavigation.inputs(new Vec3(0.9,1,0),true,false,0.6);
        check(stepUp.jump()&&stepUp.forward()==1,"Next node one block higher and close: jump and keep walking");
        check(!NativeNavigation.inputs(new Vec3(1.4,1,0),true,false,0.6).jump(),"Too far from the higher node: walk closer before jumping");
        check(!NativeNavigation.inputs(new Vec3(0.9,0.5,0),true,false,0.6).jump(),"A slab-height rise is a step, not a jump");
        check(!NativeNavigation.inputs(new Vec3(0.9,1,0),false,false,0.6).jump(),"No jump while airborne");
        check(NativeNavigation.inputs(new Vec3(1.2,0.5,0),true,true,0.6).jump(),"Stopped by a wall on a rising leg: jump");
        check(!NativeNavigation.inputs(new Vec3(1.2,0,0),true,true,0.6).jump(),"Stopped by a wall on flat ground: replanning, not jumping");
        check(!NativeNavigation.inputs(new Vec3(0.9,-1,0),true,false,0.6).jump(),"Walking off a safe drop needs no jump");
        check(NativeNavigation.inputs(new Vec3(0.2,0,0),true,false,0.6).forward()==0.5,"Waypoint approach reduces native input strength");
        check(NativeNavigation.inputs(new Vec3(0.01,0,0),true,false,0.6).forward()==0,"Arrived horizontal point releases native forward input");

        AABB standing=new AABB(-0.3,1,-0.3,0.3,2.8,0.3),raised=standing.move(0,1.25,0);
        check(!FlatApproach.collides(standing,Shapes.create(new AABB(-1,3,-1,1,4,1))),"Low ceiling allows standing body");
        check(FlatApproach.collides(standing.minmax(raised),Shapes.create(new AABB(-1,3,-1,1,4,1))),"Same low ceiling intersects the real jumping body envelope");
        var sole=Shapes.create(new AABB(0.46,1.985,0.46,0.54,1.995,0.54));
        check(FlatApproach.supported(sole,Shapes.create(new AABB(0.4,1.5,0,1,2,1))),"Stair upper tread supports checked centre");
        check(!FlatApproach.supported(sole,Shapes.create(new AABB(0,1,0,0.4,2,1))),"Side ledge without centre support rejected");
        check(!ServerController.atomicAction("navigation-3d"),"Navigation capability declaration cannot be invoked as a write action");
        check(ServerController.atomicAction("retreat-from-entity"),"Safe retreat uses the existing atomic action admission boundary");
        System.out.println("NavigationTest: "+checks+" checks passed");
    }
}
