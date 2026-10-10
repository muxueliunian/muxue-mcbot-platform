package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.*;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** The standing guard duty over a scripted body: when it takes the body, hands it back, walks back and counts fight time. */
final class GuardDutyTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static final class FakeView implements GuardDuty.View {
        long time;Vec3 feet=new Vec3(0,64,0),companion=new Vec3(3,64,0),walkedTo;
        boolean mayDrive=true,noWayBack;int walks,walkStops;
        public long now(){return time;}
        public Vec3 position(){return feet;}
        public Vec3 companion(){return companion;}
        public boolean mayDrive(){return mayDrive;}
        public boolean walkBack(Vec3 spot){if(noWayBack)throw error("NO_PATH","no way");walks++;walkedTo=spot;return false;}
        public void stopWalking(){walkStops++;}
    }
    /** A fight that wants the body while `foe` is set, and moves the body as it fights. */
    private static final class FakeCombat implements GuardDuty.Combat {
        final FakeView view;boolean foe;int ticks,stops;
        FakeCombat(FakeView view){this.view=view;}
        public boolean tick(Vec3 companion){ticks++;if(foe)view.feet=view.feet.add(1,0,0);return foe;}
        public void stop(){stops++;}
        public JsonObject json(){return obj("state",foe?"fighting":"idle","hits",0,"kills",0,"shots",0,"retreats",0,"damage",0);}
    }
    private static GuardDuty duty(FakeView view,FakeCombat combat){return new GuardDuty("Alex",UUID.randomUUID(),GuardCombat.Options.parse(JsonParser.parseString("true")),view,combat);}
    static void run() {
        idleFight();
        coverage();
        handOver();
        System.out.println("GuardDutyTest: "+checks+" checks passed");
    }
    private static void idleFight() {
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        check(!duty.tick(true,true)&&!duty.driving()&&duty.json().get("covering").getAsBoolean(),"nothing to fight: the body is left alone, the player is covered");
        Vec3 start=view.feet;
        combat.foe=true;
        check(duty.tick(true,true)&&duty.fighting(),"a foe while idle: the duty takes the body");
        view.time+=1000;duty.tick(true,true);view.time+=1000;
        combat.foe=false;
        check(duty.tick(true,true)&&view.walkedTo.equals(start)&&duty.json().get("returning").getAsBoolean(),"after an idle fight it walks back to where it stood");
        check(duty.busyMs()==2000,"fight time is counted");
        view.feet=start;
        check(!duty.tick(true,true)&&!duty.driving()&&view.walkStops==1,"back at the spot: the walk ends and the body is free again");
        // A walk back with no way gives up instead of standing stuck.
        combat.foe=true;duty.tick(true,true);duty.tick(true,true);duty.tick(true,true);combat.foe=false;view.noWayBack=true;
        check(!duty.tick(true,true)&&!duty.driving(),"no way back: it stays where the fight left it");
    }
    private static void coverage() {
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        combat.foe=true;
        view.companion=null;
        check(!duty.tick(true,true)&&duty.json().get("reason").getAsString().equals("PLAYER_AWAY")&&combat.ticks==0,"player offline or away: not covered, no fight");
        view.companion=new Vec3(GuardDuty.ENGAGE_RANGE+1,64,0);
        check(!duty.tick(true,true)&&duty.json().get("reason").getAsString().equals("TOO_FAR"),"more than 16 blocks from the player: only self-defense, no fight");
        view.companion=new Vec3(3,64,0);
        check(!duty.tick(false,false)&&duty.json().get("reason").getAsString().equals("BUSY")&&combat.ticks==0,"what runs cannot be interrupted: the duty waits");
        check(duty.tick(true,false)&&combat.ticks==1&&!duty.json().has("reason"),"the player came back: protecting again");
        view.mayDrive=false;
        check(!duty.tick(true,true)&&combat.stops==1&&!duty.fighting(),"control lost: the fight is dropped");
    }
    private static void handOver() {
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        combat.foe=true;
        check(duty.tick(true,false),"a foe during a follow: the duty takes the body");
        combat.foe=false;
        check(!duty.tick(true,false)&&view.walks==0,"with something else to go back to (a follow) it does not walk back itself");
        combat.foe=true;duty.tick(true,true);
        check(!duty.tick(false,false)&&combat.stops==1&&!duty.fighting(),"a task that cannot be interrupted starts: the fight is dropped and the body handed over");
        combat.foe=true;duty.tick(true,true);duty.interrupt();
        check(!duty.fighting()&&combat.stops==2,"a stop drops the fight but keeps the duty");
        check(duty.tick(true,true),"and the duty fights again on the next tick");
        duty.stop();
        check(combat.stops>=3&&!duty.driving(),"turning it off stops the fight");
    }
}
