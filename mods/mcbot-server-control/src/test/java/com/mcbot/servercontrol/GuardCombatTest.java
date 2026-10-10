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
        boolean retreatRefused;
        public boolean retreat(Vec3 destination,Vec3 companion,double leash){retreats++;retreatTo=destination;if(retreatRefused)throw error("NO_PATH","walled in");return false;}
        public void stopMoving(){stops++;}
        public boolean armMelee(){if(duringArm!=null)duringArm.run();return weapon;}
        public boolean cooledDown(){return cooled;}
        public float attack(GuardCombat.Foe foe){attacks++;if(duringAttack!=null)duringAttack.run();return 6;}
        public boolean hasBow(){return bow;}
        public boolean armBow(){return bow;}
        /** A spot the view finds for a shot (null: none), where an arrow is clear from, the candidates last offered, and how often it was asked. */
        Vec3 spotResult,clearFrom;List<Vec3> offered;int spotSearches,walks;boolean noRoute;
        public boolean clearShot(GuardCombat.Foe foe){return clear||clearFrom!=null&&feet.distanceTo(clearFrom)<=1.2;}
        public Vec3 shootingSpot(GuardCombat.Foe foe,List<Vec3> candidates){spotSearches++;offered=candidates;return spotResult;}
        public boolean reposition(Vec3 spot,Vec3 companion,double limit){
            if(noRoute)throw error("NO_PATH","no way");
            walks++;Vec3 step=spot.subtract(feet);feet=step.length()<=1?spot:feet.add(step.normalize());
            return feet.distanceTo(spot)<=1.2;
        }
        public int drawing(){return drawn;}
        public void draw(GuardCombat.Foe foe){if(drawn<0){drawn=0;draws++;}}
        public void release(GuardCombat.Foe foe){releases++;drawn=-1;}
        public void cancelDraw(){drawn=-1;}
        public boolean armShield(){return shield;}
        /** Where the shield was last turned to, and what the view says is in flight (the real one flies each projectile; here the test writes the answer). */
        Vec3 facing;final List<GuardCombat.Incoming> flying=new ArrayList<>();int incomingAsked;
        public void raiseShield(GuardCombat.Foe foe){raiseShieldAt(foe.position());}
        public void raiseShieldAt(Vec3 point){if(!shieldUp)raised++;shieldUp=true;facing=point;}
        public void lowerShield(){shieldUp=false;}
        public List<GuardCombat.Incoming> incoming(int ticks){incomingAsked++;return flying.stream().filter(i->i.ticks()<=ticks).sorted(Comparator.comparingInt(GuardCombat.Incoming::ticks)).toList();}
        void tick(){time+=50;if(drawn>=0)drawn++;}
    }
    static GuardCombat.Foe foe(Object id,String type,double distance,double companionDistance){return foe(id,type,distance,companionDistance,false,false,false,false);}
    static GuardCombat.Foe foe(Object id,String type,double distance,double companionDistance,boolean targetingCompanion,boolean ranged,boolean creeper,boolean boom) {
        return new GuardCombat.Foe(id,id.toString(),type,new Vec3(distance,64,0),distance,companionDistance,targetingCompanion,false,ranged,creeper,boom,false,true);
    }
    /** A skeleton whose own target is the body (charging: drawing at it). One drawing at the player is not charging: see Foe. */
    static GuardCombat.Foe archer(Object id,double distance,boolean charging) {
        return new GuardCombat.Foe(id,id.toString(),"minecraft:skeleton",new Vec3(distance,64,0),distance,distance-2,false,true,true,false,false,false,true,-1,0,charging);
    }
    static GuardCombat guard(FakeView view){return new GuardCombat(view,GuardCombat.Options.parse(JsonParser.parseString("true")));}
    static final Vec3 COMPANION=new Vec3(-2,64,0);
    static void run() {
        interruptedExecution();
        options();geometry();melee();preference();bow();retreat();creeper();noPath();friendlyFire();arming();unarmed();
        blastShield();outrun();reposition();spotCandidates();
        rangedShield();projectileShield();rangedShieldOff();flightGeometry();
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
    static GuardCombat.Foe creeperFoe(String id,double distance,boolean lit,int fuse,double blast) {
        return new GuardCombat.Foe(id,id,"minecraft:creeper",new Vec3(distance,64,0),distance,distance+2,false,false,false,true,lit,false,true,fuse,blast);
    }
    /** A lit creeper the body cannot run clear of: stand, face it, shield up; otherwise run or do nothing special. */
    private static void blastShield() {
        // Fuse of 10 ticks, blast out to 6 blocks, creeper 3 away: two blocks of running cannot get out.
        FakeView view=new FakeView();view.shield=true;GuardCombat guard=guard(view);
        view.foes.add(creeperFoe("c",3,true,10,6));
        check(guard.tick(COMPANION)&&guard.state().equals("shielding"),"cannot outrun a lit creeper: shield held");
        check(view.shieldUp&&view.retreats==0&&view.approaches==0&&view.attacks==0,"and the body stays put, no swing");
        check(guard.json().get("shields").getAsInt()==1,"one hold counted");
        view.tick();guard.tick(COMPANION);
        check(guard.json().get("shields").getAsInt()==1&&view.shieldUp,"holding on the next tick is still one hold");
        view.foes.clear();view.tick();
        check(!guard.tick(COMPANION)&&!view.shieldUp&&guard.state().equals("idle"),"creeper gone (exploded): shield lowered");
        // Plenty of fuse: the same creeper is run from, without the shield (a body using an item does not sprint).
        FakeView far=new FakeView();far.shield=true;GuardCombat run=guard(far);
        far.foes.add(creeperFoe("c",3,true,30,6));
        check(run.tick(COMPANION)&&run.state().equals("evading")&&far.retreats==1&&!far.shieldUp,"can outrun it: retreat as before, no shield");
        // Not lit: no shield and no evading; in reach it is fought like anything else.
        FakeView calm=new FakeView();calm.shield=true;GuardCombat idle=guard(calm);
        calm.foes.add(creeperFoe("c",3,false,30,6));
        idle.tick(COMPANION);
        check(!calm.shieldUp&&calm.raised==0&&calm.retreats==0&&idle.state().equals("fighting"),"an unlit creeper is no reason to shield");
        // A bow being drawn is put down first.
        FakeView archer=new FakeView();archer.shield=true;archer.bow=true;GuardCombat shoot=guard(archer);
        archer.foes.add(creeperFoe("c",12,false,30,6));shoot.tick(COMPANION);
        check(archer.drawn>=0,"the creeper far off is being shot at");
        archer.tick();archer.foes.set(0,creeperFoe("c",4,true,5,6));shoot.tick(COMPANION);
        check(archer.drawn<0&&archer.shieldUp&&shoot.state().equals("shielding")&&"SHIELD".equals(shoot.json().get("lastDrop").getAsString()),"drawn bow lowered before the shield goes up");
        // Walled in (a pit, a fence): open ground says run, but the retreat is refused; the next tick shields instead.
        FakeView pit=new FakeView();pit.shield=true;pit.retreatRefused=true;GuardCombat trapped=guard(pit);
        pit.foes.add(creeperFoe("c",3,true,30,6));
        check(trapped.tick(COMPANION)&&trapped.state().equals("evading")&&!pit.shieldUp,"first it tries to run");
        pit.tick();trapped.tick(COMPANION);
        check(trapped.state().equals("shielding")&&pit.shieldUp&&pit.retreats==1,"the retreat was refused: it stands and shields");
        // Running but still inside the blast when the fuse is nearly out: stop and shield in time.
        FakeView late=new FakeView();late.shield=true;GuardCombat runner=guard(late);
        late.foes.add(creeperFoe("c",4,true,30,6));runner.tick(COMPANION);
        check(runner.state().equals("evading"),"plenty of fuse: running");
        late.tick();late.foes.set(0,creeperFoe("c",4.5,true,GuardCombat.SHIELD_LEAD,6));runner.tick(COMPANION);
        check(runner.state().equals("shielding")&&late.shieldUp,"fuse nearly out and still within the blast: shield up");
        check(!GuardCombat.lastMoment(new Vec3(0,64,0),new Vec3(7,64,0),6,5)&&!GuardCombat.lastMoment(new Vec3(0,64,0),new Vec3(3,64,0),6,-1)&&GuardCombat.lastMoment(new Vec3(0,64,0),new Vec3(3,64,0),6,GuardCombat.SHIELD_LEAD),"last moment: only inside the blast with a known, nearly spent fuse");
        // No shield to hold: run as best it can, and say why.
        FakeView bare=new FakeView();GuardCombat nothing=guard(bare);
        bare.foes.add(creeperFoe("c",3,true,10,6));
        check(nothing.tick(COMPANION)&&nothing.state().equals("evading")&&bare.retreats==1&&"NO_SHIELD".equals(nothing.json().get("lastShield").getAsString()),"no shield on hand: still backs off, the reason is reported");
        FakeView off=new FakeView();off.shield=true;GuardCombat declined=new GuardCombat(off,GuardCombat.Options.parse(JsonParser.parseString("{\"shield\":false}")));
        off.foes.add(creeperFoe("c",3,true,10,6));declined.tick(COMPANION);
        check(!off.shieldUp&&off.retreats==1&&"OFF".equals(declined.json().get("lastShield").getAsString()),"shield:false is respected");
        // The blast reaches farther than the old 5 blocks: a lit creeper 5.5 away is already a reason to move.
        FakeView wide=new FakeView();GuardCombat reach=guard(wide);
        wide.foes.add(creeperFoe("c",5.5,true,30,6));
        check(reach.tick(COMPANION)&&reach.state().equals("evading"),"inside the blast radius, not only inside 5 blocks");
    }
    /** A bow drawn (or a crossbow loaded) at the player or the body: face it with the shield up; once it has loosed, lower and go after it. */
    private static void rangedShield() {
        FakeView view=new FakeView();view.shield=true;GuardCombat guard=guard(view);
        view.foes.add(archer("skel",12,true));
        check(guard.tick(COMPANION)&&guard.state().equals("shielding")&&view.shieldUp,"a skeleton drawing its bow at the player: shield up");
        check(view.facing.equals(new Vec3(12,64,0))&&view.approaches==0&&view.attacks==0&&view.draws==0&&view.stops>=1,"facing it, standing still, not walking or shooting");
        check("RANGED".equals(guard.json().get("blocking").getAsString())&&guard.json().get("shields").getAsInt()==1&&!guard.json().has("lastShield"),"the reason and one hold are reported");
        view.tick();guard.tick(COMPANION);
        check(view.raised==1&&guard.json().get("shields").getAsInt()==1,"holding on the next tick is still one raise");
        // Loosed: the shield stays for the hold time, then it comes down and the archer is gone after (it is not shooting now).
        view.foes.set(0,archer("skel",12,false));
        int held=0;
        while(held<20) {
            view.tick();guard.tick(COMPANION);
            if(!view.shieldUp)break;
            held++;
        }
        check(held==GuardCombat.SHIELD_DELAY-1,"the shield stays up for the shield's own delay after the last threat, then comes down: "+held);
        check(view.approaches==1&&guard.state().equals("approaching")&&!guard.json().has("blocking"),"and the fight goes on: walking to the archer");
        // The bow flickers (drawn, lowered, drawn): one raise, never down in between.
        FakeView flicker=new FakeView();flicker.shield=true;GuardCombat jitter=guard(flicker);
        for(int i=0;i<12;i++){flicker.foes.clear();flicker.foes.add(archer("skel",12,i%2==0));jitter.tick(COMPANION);flicker.tick();check(flicker.shieldUp,"flicker "+i+": shield stays up");}
        check(flicker.raised==1,"flicker: raised once");
        // Not drawing: no shield, the archer is walked to as before.
        FakeView calm=new FakeView();calm.shield=true;GuardCombat idle=guard(calm);
        calm.foes.add(archer("skel",12,false));idle.tick(COMPANION);
        check(calm.raised==0&&!calm.shieldUp&&calm.approaches==1&&idle.state().equals("approaching"),"a skeleton not drawing: no shield");
        // Not in sight: it cannot hit us, no shield.
        FakeView hidden=new FakeView();hidden.shield=true;GuardCombat wall=guard(hidden);
        hidden.foes.add(new GuardCombat.Foe("skel","skel","minecraft:skeleton",new Vec3(12,64,0),12,10,true,false,true,false,false,false,false,-1,0,true));
        wall.tick(COMPANION);
        check(hidden.raised==0,"a bow drawn without a line of sight to the body is no reason to shield");
        // With a bow of our own: the draw is put down for the shield, and drawn again once the archer has loosed.
        FakeView duel=new FakeView();duel.shield=true;duel.bow=true;GuardCombat both=guard(duel);
        duel.foes.add(archer("skel",12,false));both.tick(COMPANION);
        check(duel.drawn>=0&&duel.draws==1,"an archer resting: the bow is drawn at it");
        duel.tick();duel.foes.set(0,archer("skel",12,true));both.tick(COMPANION);
        check(duel.drawn<0&&duel.shieldUp&&both.state().equals("shielding")&&"SHIELD".equals(both.json().get("lastDrop").getAsString()),"the archer draws: our draw is lowered and the shield goes up, no shot");
        duel.tick();duel.foes.set(0,archer("skel",12,false));
        for(int i=0;i<GuardCombat.SHIELD_DELAY+1&&duel.shieldUp;i++){duel.tick();both.tick(COMPANION);}
        check(!duel.shieldUp&&duel.draws==2&&both.state().equals("shooting"),"loosed: shield down, our bow drawn again");
        // Already in reach: swing at it. Between swings the shield goes up (it is drawing at us).
        FakeView close=new FakeView();close.shield=true;GuardCombat swing=guard(close);
        close.foes.add(archer("skel",2,true));swing.tick(COMPANION);
        check(close.attacks==1&&!close.shieldUp&&swing.state().equals("fighting"),"a skeleton drawing in reach is struck, not shielded from");
        close.cooled=false;close.tick();swing.tick(COMPANION);
        check(close.attacks==1&&close.shieldUp,"waiting for the swing, the shield covers a skeleton that is drawing");
        // A melee foe in reach comes before an archer further off.
        FakeView mixed=new FakeView();mixed.shield=true;GuardCombat both2=guard(mixed);
        mixed.foes.add(foe("zombie","minecraft:zombie",2,3,true,false,false,false));mixed.foes.add(archer("skel",12,true));both2.tick(COMPANION);
        check(mixed.attacks==1&&mixed.raised==0,"a zombie in reach is struck first; no standing still for the archer");
        // A lit creeper that cannot be outrun comes first: the shield faces the creeper.
        FakeView blast=new FakeView();blast.shield=true;GuardCombat boom=guard(blast);
        blast.foes.add(creeperFoe("c",3,true,10,6));blast.foes.add(archer("skel",12,true));boom.tick(COMPANION);
        check(boom.state().equals("shielding")&&blast.facing.equals(new Vec3(3,64,0)),"creeper first: the shield faces the creeper, not the archer");
        check(GuardCombat.SHIELD_LEAD==10&&GuardCombat.SHIELD_LEAD==2*GuardCombat.SHIELD_DELAY&&GuardCombat.SHIELD_HOLD_MS==GuardCombat.SHIELD_DELAY*GuardCombat.TICK_MS,"the creeper's lead, the hold and the projectile window all come from the shield's delay");
    }
    /** Something in flight at the body: shield up if it will arrive in time to be blocked, face where it comes from; down once it has passed. */
    private static void projectileShield() {
        FakeView view=new FakeView();view.shield=true;GuardCombat guard=guard(view);
        view.flying.add(new GuardCombat.Incoming("arrow",new Vec3(20,64.5,0),8));
        check(guard.tick(COMPANION)&&guard.state().equals("shielding")&&view.shieldUp,"an arrow arriving in 8 ticks, no foe in sight: shield up");
        check(view.facing.equals(new Vec3(20,64.5,0))&&"PROJECTILE".equals(guard.json().get("blocking").getAsString())&&view.stops>=1,"turned to where it is coming from, standing still");
        // It flew by (not in the list any more): the hold time, then the shield is down and the follow has the tick again.
        view.flying.clear();
        boolean drove=true;int held=0;
        for(int i=0;i<10&&drove;i++){view.tick();drove=guard.tick(COMPANION);if(drove)held++;}
        check(!drove&&!view.shieldUp&&held==GuardCombat.SHIELD_DELAY-1&&guard.state().equals("idle"),"missed: the shield comes down after the hold time: "+held);
        // Farther than the window: not yet (the view only reports what arrives within SHIELD_LEAD ticks).
        FakeView far=new FakeView();far.shield=true;GuardCombat distant=guard(far);
        far.flying.add(new GuardCombat.Incoming("arrow",new Vec3(24,64.5,0),GuardCombat.SHIELD_LEAD+1));
        check(!distant.tick(COMPANION)&&far.raised==0,"an arrow still more than SHIELD_LEAD ticks away: nothing yet");
        // Too late for a raise to count: not raised; the very edge is.
        FakeView late=new FakeView();late.shield=true;GuardCombat tooLate=guard(late);
        late.flying.add(new GuardCombat.Incoming("arrow",new Vec3(5,64.5,0),GuardCombat.SHIELD_DELAY-1));
        check(!tooLate.tick(COMPANION)&&late.raised==0,"it arrives before a shield could be up: not raised");
        late.flying.set(0,new GuardCombat.Incoming("arrow",new Vec3(5,64.5,0),GuardCombat.SHIELD_DELAY));
        check(tooLate.tick(COMPANION)&&late.shieldUp,"arriving exactly when the shield takes effect: raised");
        // Already up (for an archer): a close arrival is kept covered rather than ignored.
        FakeView up=new FakeView();up.shield=true;GuardCombat held2=guard(up);
        up.foes.add(archer("skel",12,true));held2.tick(COMPANION);
        up.flying.add(new GuardCombat.Incoming("arrow",new Vec3(4,64.5,0),1));up.tick();held2.tick(COMPANION);
        check(up.shieldUp&&up.raised==1&&up.facing.equals(new Vec3(4,64.5,0))&&"PROJECTILE".equals(held2.json().get("blocking").getAsString()),"a shield already up turns to the arrow that is about to land");
        // A foe in reach: the swing first, even with an arrow coming.
        FakeView near=new FakeView();near.shield=true;GuardCombat fight=guard(near);
        near.foes.add(foe("zombie","minecraft:zombie",2,3));near.flying.add(new GuardCombat.Incoming("arrow",new Vec3(10,64.5,0),6));
        fight.tick(COMPANION);
        check(near.attacks==1&&near.raised==0&&near.incomingAsked==0,"a zombie in reach is struck; the flight is not even looked at");
        // A bow drawn is put down for it.
        FakeView bowed=new FakeView();bowed.shield=true;bowed.bow=true;bowed.drawn=3;GuardCombat shoot=guard(bowed);
        bowed.flying.add(new GuardCombat.Incoming("arrow",new Vec3(20,64.5,0),8));shoot.tick(COMPANION);
        check(bowed.drawn<0&&bowed.shieldUp&&"SHIELD".equals(shoot.json().get("lastDrop").getAsString()),"a drawn bow is lowered for the shield");
    }
    /** No shield, or shield:false: the fight is the same as before, and the reason can be read. */
    private static void rangedShieldOff() {
        FakeView bare=new FakeView();GuardCombat none=guard(bare);
        bare.foes.add(archer("skel",12,true));
        check(none.tick(COMPANION)&&bare.raised==0&&bare.approaches==1&&none.state().equals("approaching")&&"NO_SHIELD".equals(none.json().get("lastShield").getAsString()),"no shield on hand: the archer is walked to as before, and the reason is reported");
        FakeView armed=new FakeView();armed.bow=true;GuardCombat shooter=guard(armed);
        armed.foes.add(archer("skel",12,true));shooter.tick(COMPANION);armed.tick();shooter.tick(COMPANION);
        check(armed.draws==1&&armed.drawn>=0&&shooter.state().equals("shooting"),"no shield, a bow: the draw is not dropped, the duel goes on");
        FakeView off=new FakeView();off.shield=true;GuardCombat declined=new GuardCombat(off,GuardCombat.Options.parse(JsonParser.parseString("{\"shield\":false}")));
        off.foes.add(archer("skel",12,true));off.flying.add(new GuardCombat.Incoming("arrow",new Vec3(20,64.5,0),8));
        check(declined.tick(COMPANION)&&off.raised==0&&!off.shieldUp&&off.approaches==1&&"OFF".equals(declined.json().get("lastShield").getAsString()),"shield:false is respected");
        check(off.incomingAsked==0,"and nothing is scanned for in-flight projectiles");
        // The old creeper reason still wins its own entry in lastShield.
        FakeView clean=new FakeView();clean.shield=true;GuardCombat fine=guard(clean);
        clean.foes.add(archer("skel",12,false));fine.tick(COMPANION);
        check(!fine.json().has("lastShield"),"nothing to report when nothing was aimed at us");
    }
    /** Where a projectile goes: straight, or as an arrow drops; misses, and what is already inside. */
    private static void flightGeometry() {
        net.minecraft.world.phys.AABB body=new net.minecraft.world.phys.AABB(-0.3,64,-0.3,0.3,65.8,0.3);
        Vec3 from=new Vec3(20,64.9,0),inwards=new Vec3(-2,0,0);
        check(GuardCombat.ticksToHit(from,inwards,1,0,body,20)==10,"straight at the body, 2 blocks a tick from 20: the 10th move reaches the widened box");
        check(GuardCombat.ticksToHit(from,inwards,1,0,body,9)==-1,"beyond the window it is not reported");
        check(GuardCombat.ticksToHit(new Vec3(20,65.5,0),inwards,1,0,body,20)>0&&GuardCombat.ticksToHit(new Vec3(20,65.5,0),inwards,GuardCombat.ARROW_DRAG,GuardCombat.ARROW_GRAVITY,body,20)==-1,"an arrow aimed level drops under the body, a straight flight would hit");
        int high=GuardCombat.ticksToHit(new Vec3(20,67,0),inwards,GuardCombat.ARROW_DRAG,GuardCombat.ARROW_GRAVITY,body,20);
        check(high>=10&&high<=12,"an arrow loosed high comes down into the body: "+high);
        check(GuardCombat.ticksToHit(new Vec3(20,64.9,4),inwards,1,0,body,20)==-1,"passing four blocks to the side: no");
        check(GuardCombat.ticksToHit(new Vec3(5,64.9,0),new Vec3(2,0,0),1,0,body,20)==-1,"flying away: no");
        check(GuardCombat.ticksToHit(new Vec3(0.1,64.9,0),inwards,1,0,body,20)==-1,"already inside the box (stuck in it, or just past): nothing to block");
        check(GuardCombat.ticksToHit(new Vec3(3,64.9,0),new Vec3(-3,0,0),1,0,body,20)==1,"fast enough to arrive on the next move");
        check(GuardCombat.ticksToHit(new Vec3(3,64.9,0),Vec3.ZERO,1,0,body,20)==-1,"not moving: no");
    }
    private static void outrun() {
        Vec3 feet=new Vec3(0,64,0),creeper=new Vec3(3,64,0),player=new Vec3(-2,64,0);
        check(GuardCombat.canOutrun(feet,creeper,player,12,6,-1),"an unknown fuse counts as: run, as before");
        check(!GuardCombat.canOutrun(feet,creeper,player,12,6,10)&&GuardCombat.canOutrun(feet,creeper,player,12,6,30),"ten ticks are too few, thirty enough");
        check(GuardCombat.canOutrun(feet,new Vec3(20,64,0),player,12,6,1),"already outside the blast");
        // The player's leash stops the run: body 10 out, creeper between it and the player's side.
        Vec3 edge=new Vec3(10,64,0),near=new Vec3(4,64,0),origin=new Vec3(0,64,0);
        check(GuardCombat.canOutrun(edge,near,origin,30,8,100)&&!GuardCombat.canOutrun(edge,near,origin,12,8,100),"a short leash leaves no room to run even with plenty of fuse");
        check(!GuardCombat.canOutrun(feet,creeper,player,12,12,25)&&GuardCombat.canOutrun(feet,creeper,player,12,6,25),"a charged creeper's blast is twice as far");
    }
    /** The body shoots from a better spot when the arrow cannot reach from where it stands. */
    private static void reposition() {
        FakeView view=new FakeView();view.bow=true;GuardCombat guard=guard(view);
        view.foes.add(foe("skeleton","minecraft:skeleton",12,10,false,true,false,false));
        view.clear=false;view.spotResult=new Vec3(1,64,2);view.clearFrom=view.spotResult;
        check(guard.tick(COMPANION)&&guard.state().equals("repositioning"),"arrow blocked and a spot found: walk there");
        check(view.spotSearches==1&&view.walks==1&&view.drawn<0&&view.draws==0,"one search, one step, no draw while walking");
        check(view.offered!=null&&view.offered.stream().allMatch(v->v.distanceTo(COMPANION)<=GuardCombat.spotLimit(guard.options)),"only spots inside the protection range were offered");
        check("WALKING".equals(guard.json().get("lastReposition").getAsString())&&guard.json().get("repositions").getAsInt()==1,"the walk is readable in the state");
        for(int i=0;i<6&&view.draws==0;i++){view.tick();guard.tick(COMPANION);}
        check(view.feet.distanceTo(view.spotResult)<=1.2&&view.draws==1&&guard.state().equals("shooting"),"at the spot the bow is drawn");
        check(view.spotSearches==1,"no second search once the shot is clear");
        // Nothing reachable: stay, do not draw into the wall, say why; search again only after the cooldown.
        FakeView stuck=new FakeView();stuck.bow=true;GuardCombat still=guard(stuck);
        stuck.foes.add(foe("skeleton","minecraft:skeleton",12,10,false,true,false,false));stuck.clear=false;
        check(still.tick(COMPANION)&&still.state().equals("aiming")&&stuck.walks==0,"no spot: hold position");
        check("NO_SPOT".equals(still.json().get("lastReposition").getAsString()),"and the reason can be read: "+still.json());
        for(int i=0;i<5;i++){stuck.tick();still.tick(COMPANION);}
        check(stuck.spotSearches==1,"searching is rationed, not every tick");
        for(int i=0;i<20;i++){stuck.tick();still.tick(COMPANION);}
        check(stuck.spotSearches==2&&stuck.walks==0,"after the cooldown it looks again");
        // A spot with no way to walk: the foe is marked, the spot is not offered again, no endless trying.
        FakeView walled=new FakeView();walled.bow=true;GuardCombat blocked=guard(walled);
        walled.foes.add(foe("skeleton","minecraft:skeleton",12,10,false,true,false,false));walled.clear=false;
        walled.spotResult=new Vec3(1,64,0);walled.noRoute=true;
        check(blocked.tick(COMPANION)&&"NO_PATH".equals(blocked.json().get("lastReposition").getAsString()),"no path to the spot: given up, reason reported");
        walled.noRoute=false;for(int i=0;i<25;i++){walled.tick();blocked.tick(COMPANION);}
        check(walled.offered.stream().noneMatch(v->Math.hypot(v.x-1,v.z)<1.0),"a spot that had no way is not offered again");
        // Melee takes over: a foe that closes in stops the walk.
        FakeView close=new FakeView();close.bow=true;GuardCombat fight=guard(close);
        close.foes.add(foe("skeleton","minecraft:skeleton",12,10,false,true,false,false));close.clear=false;close.spotResult=new Vec3(0,64,3);
        fight.tick(COMPANION);
        close.foes.set(0,foe("skeleton","minecraft:skeleton",2,3,false,true,false,false));close.tick();fight.tick(COMPANION);
        check(fight.state().equals("fighting")&&close.attacks==1,"a foe in reach is fought, the walk dropped");
    }
    /** Candidate spots: rings around the feet, nearest first, inside the protection range, never close enough to switch to melee. */
    private static void spotCandidates() {
        GuardCombat.Options defaults=GuardCombat.Options.parse(JsonParser.parseString("true"));
        check(Math.abs(GuardCombat.spotLimit(defaults)-(12-GuardCombat.SPOT_EDGE))<1e-9,"default leash 12: spots stay 1.5 inside it");
        GuardCombat.Options wide=GuardCombat.Options.parse(JsonParser.parseString("{\"radius\":12}"));
        check(GuardCombat.spotLimit(wide)<=GuardDuty.ENGAGE_RANGE-GuardCombat.SPOT_EDGE,"a leash of 16 is still held inside the range the duty takes the body in (ENGAGE_RANGE, body to player)");
        Vec3 feet=new Vec3(0,64,0),foe=new Vec3(15,64,0),player=new Vec3(-2,64,0);
        List<Vec3> all=GuardCombat.repositionCandidates(feet,foe,player,10.5,List.of());
        check(all.size()==32,"four rings of eight directions when nothing is excluded");
        for(int i=1;i<all.size();i++)check(feet.distanceTo(all.get(i-1))<=feet.distanceTo(all.get(i))+1e-9,"nearest first");
        Vec3 rim=new Vec3(10,64,0);
        List<Vec3> edge=GuardCombat.repositionCandidates(rim,new Vec3(30,64,0),new Vec3(0,64,0),10.5,List.of());
        check(!edge.isEmpty()&&edge.stream().allMatch(v->v.distanceTo(new Vec3(0,64,0))<=10.5),"at the rim of the range, no candidate leads out of it");
        check(edge.stream().noneMatch(v->v.x>10.5),"outward spots are dropped");
        List<Vec3> none=GuardCombat.repositionCandidates(new Vec3(10.4,64,0),new Vec3(30,64,0),new Vec3(0,64,0),10.0,List.of());
        check(none.stream().allMatch(v->v.distanceTo(new Vec3(0,64,0))<=10.0),"a body already outside the limit is only offered spots back inside");
        List<Vec3> nearFoe=GuardCombat.repositionCandidates(feet,new Vec3(5,64,0),player,10.5,List.of());
        check(nearFoe.stream().allMatch(v->Math.hypot(v.x-5,v.z)>=GuardCombat.BOW_MIN),"no spot within bow minimum of the foe (that would be melee)");
        List<Vec3> avoided=GuardCombat.repositionCandidates(feet,foe,player,10.5,List.of(new Vec3(1,64,0)));
        check(avoided.stream().noneMatch(v->Math.hypot(v.x-1,v.z)<1.0)&&avoided.size()<all.size(),"spots near one that had no way are left out");
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
