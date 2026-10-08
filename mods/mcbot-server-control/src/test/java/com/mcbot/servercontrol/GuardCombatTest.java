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
        int approaches,retreats,attacks,draws,releases,stops,raised;boolean shieldUp;Vec3 retreatTo;
        public long now(){return time;}
        public Vec3 position(){return feet;}
        public float health(){return health;}
        public List<GuardCombat.Foe> foes(Vec3 companion,double radius){return foes.stream().filter(f->!dead.contains(f.identity())).toList();}
        public boolean dead(GuardCombat.Foe foe){return dead.contains(foe.identity());}
        public boolean inReach(GuardCombat.Foe foe){return foe.distance()<=3&&!blocked.contains(foe.identity());}
        public boolean approach(GuardCombat.Foe foe,Vec3 companion,double leash){if(noPath)throw error("NO_PATH","no way");approaches++;return false;}
        public boolean retreat(Vec3 destination,Vec3 companion,double leash){retreats++;retreatTo=destination;return false;}
        public void stopMoving(){stops++;}
        public boolean armMelee(){return weapon;}
        public boolean cooledDown(){return cooled;}
        public float attack(GuardCombat.Foe foe){attacks++;return 6;}
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
        options();geometry();melee();preference();bow();retreat();creeper();noPath();
        System.out.println("GuardCombatTest: "+checks+" checks passed");
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
}
