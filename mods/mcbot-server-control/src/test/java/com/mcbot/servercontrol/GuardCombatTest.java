package com.mcbot.servercontrol;

import com.google.gson.JsonParser;
import java.util.*;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** Guard decisions over a scripted world: who to fight, melee or bow, shield, retreat, and the leash. */
final class GuardCombatTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    /** A body standing at the origin; foes are plain records the test moves by hand. */
    static final class FakeView implements GuardCombat.View {
        long time;Vec3 feet=new Vec3(0,64,0);float health=20;
        final List<GuardCombat.Foe> foes=new ArrayList<>();final Set<Object> dead=new HashSet<>(),blocked=new HashSet<>();
        boolean bow,shield,weapon=true,cooled=true,clear=true,noPath;int drawn=-1;
        Runnable duringAttack,duringArm;int approaches,retreats,attacks,draws,releases,stops,raised;boolean shieldUp;Vec3 retreatTo;
        public long now(){return time;}
        public Vec3 position(){return feet;}
        public float health(){return health;}
        public List<GuardCombat.Foe> foes(Vec3 companion,double radius){return foes.stream().filter(f->!dead.contains(f.identity())).toList();}
        public boolean dead(GuardCombat.Foe foe){return dead.contains(foe.identity());}
        public boolean inReach(GuardCombat.Foe foe){return foe.distance()<=3&&!blocked.contains(foe.identity());}
        public boolean approach(GuardCombat.Foe foe,Vec3 companion,double leash){if(noPath)throw error("NO_PATH","no way");approaches++;return false;}
        public boolean retreat(Vec3 destination,Vec3 companion,double leash){retreats++;retreatTo=destination;return false;}
        public void stopMoving(){stops++;}
        public boolean armMelee(){if(duringArm!=null)duringArm.run();return weapon;}
        public boolean cooledDown(){return cooled;}
        public float attack(GuardCombat.Foe foe){attacks++;if(duringAttack!=null)duringAttack.run();return 6;}
        public boolean hasBow(){return bow;}
        public boolean armBow(){return bow;}
        public boolean clearShot(GuardCombat.Foe foe){return clear;}
        public int drawing(){return drawn;}
        public void draw(GuardCombat.Foe foe){if(drawn<0){drawn=0;draws++;}}
        public void release(GuardCombat.Foe foe){releases++;drawn=-1;}
        public void cancelDraw(){drawn=-1;}
        public boolean armShield(){return shield;}
        public void raiseShield(GuardCombat.Foe foe){if(!shieldUp)raised++;shieldUp=true;}
        public void lowerShield(){shieldUp=false;}
        void tick(){time+=50;if(drawn>=0)drawn++;}
    }
    static GuardCombat.Foe foe(Object id,String type,double distance,double companionDistance){return foe(id,type,distance,companionDistance,false,false,false,false);}
    static GuardCombat.Foe foe(Object id,String type,double distance,double companionDistance,boolean targetingCompanion,boolean ranged,boolean creeper,boolean boom) {
        return new GuardCombat.Foe(id,id.toString(),type,new Vec3(distance,64,0),distance,companionDistance,targetingCompanion,false,ranged,creeper,boom,false,true);
    }
    static GuardCombat guard(FakeView view){return new GuardCombat(view,GuardCombat.Options.parse(JsonParser.parseString("true")));}
    static final Vec3 COMPANION=new Vec3(-2,64,0);
    static void run() {
        interruptedExecution();
        options();geometry();melee();preference();bow();retreat();creeper();noPath();friendlyFire();arming();unarmed();
        System.out.println("GuardCombatTest: "+checks+" checks passed");
    }
    /** No melee weapon: hold a weapon, keep a bare or armed hand, take an empty hotbar slot, else stow what is held into the main inventory; full everywhere gives up. */
    private static void arming() {
        java.util.function.IntPredicate none=i->false;
        check(GuardCombat.arming(0,false,false,14,false,none).equals(new GuardCombat.Arming(GuardCombat.Arm.HOLD,14)),"a verified weapon anywhere is held first");
        check(GuardCombat.arming(2,true,false,5,true,none).equals(new GuardCombat.Arming(GuardCombat.Arm.HOLD,5))&&GuardCombat.arming(2,true,false,2,false,none).equals(new GuardCombat.Arming(GuardCombat.Arm.READY,2)),"a better weapon replaces the held one; the best one already held is kept");
        check(GuardCombat.arming(3,false,true,-1,false,none).equals(new GuardCombat.Arming(GuardCombat.Arm.READY,3)),"an empty hand fights as it is");
        check(GuardCombat.arming(3,false,false,-1,false,i->i==6||i==20).equals(new GuardCombat.Arming(GuardCombat.Arm.HOLD,6)),"a free hotbar slot is selected before anything is moved");
        // The trial: a hotbar of golden apples, bow, arrows and logs, no sword or axe, room in the main inventory.
        GuardCombat.Arming stow=GuardCombat.arming(0,false,false,-1,false,i->i==17||i==30);
        check(stow.equals(new GuardCombat.Arming(GuardCombat.Arm.STOW,17)),"hotbar full and no weapon: the held stack goes to the first empty main inventory slot, the bare hand fights");
        check(GuardCombat.arming(0,false,false,-1,false,none).equals(new GuardCombat.Arming(GuardCombat.Arm.NONE,-1)),"hotbar and main inventory full: nothing is held, the fight is given up");
        check(GuardCombat.arming(0,false,false,-1,false,i->i==40).arm()==GuardCombat.Arm.NONE,"armour and off-hand slots are not somewhere to stow the held stack");
    }
    /** When the hand cannot be emptied the guard gives that foe up and says why; once it can fight again the reason goes. */
    private static void unarmed() {
        FakeView view=new FakeView();GuardCombat guard=guard(view);
        Object zombie=new Object();view.foes.add(foe(zombie,"minecraft:zombie",2,3));
        view.weapon=false;
        check(!guard.tick(COMPANION)&&view.attacks==0&&"idle".equals(guard.state()),"no free hand: no swing with whatever is held");
        check("NO_FREE_HAND".equals(guard.json().get("unarmed").getAsString()),"the observation says why: "+guard.json());
        view.tick();check(!guard.tick(COMPANION)&&view.attacks==0,"that foe is left alone for a while instead of retrying every tick");
        view.time+=60_000;view.weapon=true;
        check(guard.tick(COMPANION)&&view.attacks==1&&!guard.json().has("unarmed"),"with a hand free again it fights and the reason is cleared");
    }
    private static void options() {
        GuardCombat.Options defaults=GuardCombat.Options.parse(JsonParser.parseString("true"));
        check(defaults.radius()==8&&defaults.leash()==12&&defaults.lowHealth()==8&&defaults.bow()&&defaults.shield(),"guard:true uses the defaults (8 blocks, leash 12, retreat at 8 health, bow and shield on)");
        check(GuardCombat.Options.parse(JsonParser.parseString("false"))==null&&GuardCombat.Options.parse(null)==null,"guard:false or absent means an ordinary follow");
        GuardCombat.Options custom=GuardCombat.Options.parse(JsonParser.parseString("{\"radius\":12,\"bow\":false}"));
        check(custom.radius()==12&&custom.leash()==16&&!custom.bow()&&custom.shield(),"radius and switches are taken, the leash is capped at 16");
        errorCode("INVALID_ARGUMENT",()->GuardCombat.Options.parse(JsonParser.parseString("{\"radius\":40}")));
        errorCode("INVALID_ARGUMENT",()->GuardCombat.Options.parse(JsonParser.parseString("{\"lowHealth\":1}")));
        errorCode("INVALID_ARGUMENT",()->GuardCombat.Options.parse(JsonParser.parseString("3")));
    }
    private static void geometry() {
        double pitch=GuardCombat.arrowPitch(15,0);
        check(pitch<0&&pitch>-10,"a level 15-block shot aims slightly up");
        check(Math.abs(GuardCombat.arrowHeight(Math.toRadians(-pitch),15))<0.05,"the chosen pitch crosses the target height");
        check(GuardCombat.arrowPitch(20,4)<GuardCombat.arrowPitch(20,0),"a higher target needs a higher aim");
        check(Double.isNaN(GuardCombat.arrowPitch(10,60)),"an unreachable height has no pitch");
        // The 3D flight the bow checks for blocks agrees with the pitch solver: aimed at a point, it passes through it.
        for(double[] c:new double[][]{{15,0},{24,3},{8,-2},{20,-4}}) {
            float yaw=37f;double h=c[0],dy=c[1];
            net.minecraft.world.phys.Vec3 from=new net.minecraft.world.phys.Vec3(1,64,-2);
            net.minecraft.world.phys.Vec3 target=from.add(-Math.sin(Math.toRadians(yaw))*h,dy,Math.cos(Math.toRadians(yaw))*h);
            java.util.List<net.minecraft.world.phys.Vec3> path=GuardCombat.arrowPath(from,yaw,(float)GuardCombat.arrowPitch(h,dy),100);
            check(Math.abs(path.get(1).distanceTo(from)-3)<1e-6,"a full-power arrow covers 3 blocks in its first tick");
            double closest=Double.MAX_VALUE;for(int i=1;i<path.size();i++)closest=Math.min(closest,GuardCombat.segmentDistance(target,path.get(i-1),path.get(i)));
            check(closest<0.1,"the arrow's flight passes through the aimed point ("+h+" out, "+dy+" up): "+closest);
        }
        check(GuardCombat.AIM_HEIGHTS[0]==0.5&&GuardCombat.AIM_HEIGHTS[GuardCombat.AIM_HEIGHTS.length-1]>0.9,"the middle first, the head last");
        check(Math.abs(GuardCombat.segmentDistance(new Vec3(5,1,0),Vec3.ZERO,new Vec3(10,0,0))-1)<1e-9,"distance to the middle of the path");
        check(Math.abs(GuardCombat.segmentDistance(new Vec3(12,0,0),Vec3.ZERO,new Vec3(10,0,0))-2)<1e-9,"past the end of the path counts from its end");
        Vec3 feet=new Vec3(0,64,0);
        check(GuardCombat.retreatPoint(feet,new Vec3(3,64,0),new Vec3(-4,64,0),12).equals(new Vec3(-4,64,0)),"retreat goes to the player when the player is away from the foe");
        Vec3 away=GuardCombat.retreatPoint(feet,new Vec3(-3,64,0),new Vec3(-2,64,1),12);
        check(away.x>4&&away.distanceTo(new Vec3(-2,64,1))<=11.001,"otherwise straight away from the foe, inside the leash");
        Vec3 leashed=GuardCombat.retreatPoint(new Vec3(10,64,0),new Vec3(7,64,0),new Vec3(0,64,0),12);
        check(new Vec3(leashed.x,64,leashed.z).distanceTo(new Vec3(0,64,0))<=11.001,"a retreat point never leaves the leash");
    }
    private static void melee() {
        FakeView view=new FakeView();GuardCombat guard=guard(view);
        check(!guard.tick(COMPANION)&&guard.state().equals("idle"),"nothing near: the follow keeps the tick");
        view.foes.add(foe("zombie","minecraft:zombie",6,5));
        check(guard.tick(COMPANION)&&guard.state().equals("approaching")&&view.approaches==1,"a zombie near the player is approached, not waited for");
        view.foes.set(0,foe("zombie","minecraft:zombie",2,3));view.tick();
        check(guard.tick(COMPANION)&&guard.state().equals("fighting")&&view.attacks==1,"in reach and cooled down: one swing");
        view.cooled=false;view.shield=true;view.tick();guard.tick(COMPANION);
        check(view.attacks==1&&view.raised==0,"waiting for the swing; no shield against a foe not attacking the body");
        view.foes.set(0,new GuardCombat.Foe("zombie","zombie","minecraft:zombie",new Vec3(2,64,0),2,3,false,true,false,false,false,false,true));view.tick();guard.tick(COMPANION);
        check(view.shieldUp,"shield up between swings when the foe attacks the body");
        view.cooled=true;view.tick();guard.tick(COMPANION);
        check(view.attacks==2&&!view.shieldUp,"shield lowered for the next swing");
        view.dead.add("zombie");view.tick();
        check(!guard.tick(COMPANION)&&guard.state().equals("idle")&&guard.json().get("kills").getAsInt()==1&&guard.json().get("hits").getAsInt()==2,"the killed foe is counted and the follow resumes");
    }
    private static void preference() {
        FakeView view=new FakeView();GuardCombat guard=guard(view);
        view.foes.add(foe("near","minecraft:zombie",2,6));
        view.foes.add(foe("hunter","minecraft:spider",5,2,true,false,false,false));
        guard.tick(COMPANION);
        check(guard.json().get("target").getAsString().equals("minecraft:spider"),"whoever attacks the player comes first, even when another foe is nearer the body");
        view.foes.add(foe("other","minecraft:husk",1,1,true,false,false,false));view.tick();guard.tick(COMPANION);
        check(guard.json().get("targetId").getAsString().equals("hunter"),"the current foe is kept while it stays eligible");
    }
    private static void bow() {
        FakeView view=new FakeView();view.bow=true;GuardCombat guard=guard(view);
        view.foes.add(foe("skeleton","minecraft:skeleton",12,10,false,true,false,false));
        guard.tick(COMPANION);
        check(guard.state().equals("shooting")&&view.draws==1&&view.approaches==0,"a skeleton at range is shot, not chased");
        for(int i=0;i<25&&view.releases==0;i++){view.tick();guard.tick(COMPANION);}
        check(view.releases==1&&guard.json().get("shots").getAsInt()==1,"released only at full draw");
        view.clear=false;for(int i=0;i<30;i++){view.tick();guard.tick(COMPANION);}
        check(view.releases==1&&guard.state().equals("aiming"),"someone in the line of fire: the draw is held, no arrow");
        view.clear=true;view.foes.set(0,foe("skeleton","minecraft:skeleton",2,3,false,true,false,false));view.tick();guard.tick(COMPANION);
        check(view.drawn<0&&view.attacks==1,"in reach the bow is put away for a swing");
        FakeView close=new FakeView();close.bow=true;GuardCombat chase=guard(close);
        close.foes.add(foe("zombie","minecraft:zombie",5,4));chase.tick(COMPANION);
        check(close.approaches==1&&close.draws==0,"a melee foe close by is met with the sword, not a slow draw");
        FakeView off=new FakeView();off.bow=true;GuardCombat noBow=new GuardCombat(off,GuardCombat.Options.parse(JsonParser.parseString("{\"bow\":false}")));
        off.foes.add(foe("skeleton","minecraft:skeleton",12,10,false,true,false,false));noBow.tick(COMPANION);
        check(off.draws==0&&off.approaches==1,"bow:false never draws");
    }
    private static void retreat() {
        FakeView view=new FakeView();view.shield=true;GuardCombat guard=guard(view);
        view.foes.add(foe("zombie","minecraft:zombie",2,3));view.health=7;
        check(guard.tick(COMPANION)&&guard.state().equals("retreating")&&view.attacks==0&&view.retreats==1&&view.shieldUp,"low health: back off behind the shield instead of swinging");
        check(guard.json().get("retreats").getAsInt()==1,"the retreat is counted once");
        view.health=10;view.tick();guard.tick(COMPANION);
        check(guard.state().equals("retreating")&&guard.json().get("retreats").getAsInt()==1,"keeps backing off until health is back above the threshold plus 4");
        view.health=12;view.tick();guard.tick(COMPANION);
        check(guard.state().equals("fighting")&&view.attacks==1,"recovered: fights again");
        FakeView alone=new FakeView();GuardCombat calm=guard(alone);alone.health=5;
        check(!calm.tick(COMPANION),"low health with nothing near: just follow");
    }
    private static void creeper() {
        FakeView view=new FakeView();GuardCombat guard=guard(view);
        view.foes.add(foe("creeper","minecraft:creeper",3,4,false,false,true,true));
        check(guard.tick(COMPANION)&&guard.state().equals("evading")&&view.attacks==0,"a swelling creeper is backed away from");
        FakeView archer=new FakeView();archer.bow=true;GuardCombat shoot=guard(archer);
        archer.foes.add(foe("creeper","minecraft:creeper",6,5,false,false,true,false));shoot.tick(COMPANION);
        check(archer.draws==1&&archer.approaches==0,"a creeper is shot from range when there is a bow");
    }
    private static void noPath() {
        FakeView view=new FakeView();view.noPath=true;GuardCombat guard=guard(view);
        view.foes.add(foe("zombie","minecraft:zombie",6,5));
        check(!guard.tick(COMPANION)&&guard.state().equals("idle"),"no way to the foe: the follow carries on");
        view.noPath=false;view.tick();
        check(!guard.tick(COMPANION)&&view.approaches==0,"the unreachable foe is left alone for a while");
        view.time+=GuardCombat.NO_PATH_MS+1;
        check(guard.tick(COMPANION)&&view.approaches==1,"and tried again later");
        FakeView flier=new FakeView();GuardCombat sky=guard(flier);
        flier.foes.add(new GuardCombat.Foe("phantom","phantom","minecraft:phantom",new Vec3(6,70,0),8,8,true,false,false,false,false,true,true));
        check(!sky.tick(COMPANION)&&flier.approaches==0,"no bow: a flying foe out of reach is not chased");
    }
    private static void friendlyFire() {
        check(GuardCombat.blocksFriendlyFire(true,false,false,true),"the live body's own hit on a pet or player is cancelled");
        check(GuardCombat.blocksFriendlyFire(false,true,false,true),"a tagged arrow still in flight after the body logged out (no owner) is cancelled");
        check(GuardCombat.blocksFriendlyFire(true,true,false,true),"a tagged arrow with a live owner is cancelled");
        check(!GuardCombat.blocksFriendlyFire(false,false,false,true),"damage from someone else onto a pet is not this guard's business");
        check(!GuardCombat.blocksFriendlyFire(true,true,false,false),"the body may hurt hostile mobs with its arrows");
        check(!GuardCombat.blocksFriendlyFire(true,true,true,true),"the body's own damage to itself is not blocked");
        check(GuardCombat.BODY_PROJECTILE_TAG.equals("mcbot_body_projectile"),"the projectile tag is stable across a restart");
    }
    private static void interruptedExecution() {
        FakeView view=new FakeView();
        Object identity=new Object();
        view.foes.add(new GuardCombat.Foe(identity,UUID.randomUUID().toString(),"minecraft:zombie",new Vec3(1,64,0),1,1,true,true,false,false,false,false,true));
        GuardCombat combat=new GuardCombat(view,GuardCombat.Options.parse(JsonParser.parseString("true")));
        view.duringArm=combat::stop;
        check(!combat.tick(new Vec3(0,64,0))&&view.attacks==0,"stop inside equipment callback prevents a later attack in that tick");
        view.duringArm=null;view.duringAttack=combat::stop;
        check(!combat.tick(new Vec3(0,64,0))&&combat.state().equals("idle"),"stop inside attack cannot publish fighting again");
        view.duringAttack=null;
        check(combat.tick(new Vec3(0,64,0)),"standing intent may fight on a fresh tick after stop");
    }
}
