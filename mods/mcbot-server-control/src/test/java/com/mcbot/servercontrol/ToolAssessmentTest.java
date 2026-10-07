package com.mcbot.servercontrol;

import java.util.*;
import net.minecraft.world.item.Tiers;
import static com.mcbot.servercontrol.Protocol.*;

/** Candidate-fact selection; actual native block/tag/player eligibility belongs to the real-game matrix. */
public final class ToolAssessmentTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static ToolAssessment.Candidate candidate(int slot,float speed,Boolean eligible,Integer remaining,boolean complete,boolean drops,int silk) {
        return new ToolAssessment.Candidate(slot,obj("slot",slot,"count",1),eligible,speed,remaining,complete,drops,silk,0);
    }
    public static void main(String[] args){run();}
    static void run() {
        var defaults=ToolAssessment.Policy.defaults();
        // These are pinned native tier speeds, not actual block/drop-eligibility tests.
        float[] speed={Tiers.WOOD.getSpeed(),Tiers.STONE.getSpeed(),Tiers.IRON.getSpeed(),Tiers.GOLD.getSpeed(),Tiers.DIAMOND.getSpeed()};
        float[] expected={2,4,6,12,8};for(int i=0;i<speed.length;i++)check(speed[i]==expected[i],"pinned tier base speed "+i);
        List<ToolAssessment.Candidate> stone=new ArrayList<>();for(int i=0;i<speed.length;i++)stone.add(candidate(i,speed[i],true,100,true,true,0));
        check(ToolAssessment.recommend(stone,0,defaults,false).slot()==3,"qualified gold facts win by speed rather than tier order");
        var woodIron=candidate(0,speed[0],false,100,true,true,0);var goldIron=candidate(1,speed[3],false,100,true,true,0);var iron=candidate(2,speed[2],true,100,true,true,0);
        check(ToolAssessment.recommend(List.of(woodIron,goldIron,iron),0,defaults,false)==iron,"unqualified wood/gold facts cannot beat eligible iron");
        var ironObsidian=candidate(0,speed[2],false,100,true,true,0);var diamond=candidate(20,speed[4],true,1000,true,true,0);
        check(ToolAssessment.recommend(List.of(ironObsidian,diamond),0,defaults,false)==diamond,"full-inventory qualified candidate wins");
        check(ToolAssessment.recommend(List.of(ironObsidian,diamond),0,defaults,true)==null,"inventory slot20 never leaks into hotbar-only field");
        var axe=candidate(10,6,true,100,true,true,0);var hand=candidate(0,1,true,null,true,true,0);
        check(ToolAssessment.recommend(List.of(axe,hand),0,defaults,false)==axe,"faster axe facts beat eligible hand");
        check(ToolAssessment.recommend(List.of(axe,hand),0,defaults,true)==hand,"hotbar recommendation may retain eligible empty hand");
        var emptyMain=candidate(9,1,true,null,true,true,0);emptyMain.value().addProperty("count",0);
        var emptyHotbar=candidate(4,1,true,null,true,true,0);emptyHotbar.value().addProperty("count",0);
        check(ToolAssessment.recommend(List.of(emptyMain),0,defaults,false)==null,"empty main slot cannot masquerade as a usable hand");
        check(ToolAssessment.recommend(List.of(emptyMain,emptyHotbar),0,defaults,false)==emptyHotbar,"existing empty hotbar remains selectable for hand harvesting");
        check(ToolAssessment.estimatedTicks(1.5f,2,true,false)==23,"qualified estimate uses30 divisor and rounds up");
        check(ToolAssessment.estimatedTicks(3,2,false,false)==150,"unqualified estimate uses100 divisor without claiming drops");
        check(ToolAssessment.estimatedTicks(1,Float.NaN,true,false)==null,"nonfinite speed remains unknown");
        check(ToolAssessment.estimatedTicks(1,0,true,false)==null,"zero speed has no finite estimate");
        check(ToolAssessment.estimatedTicks(1,3,null,false)==null,"unknown eligibility has no invented timing");
        check(ToolAssessment.estimatedTicks(-1,3,true,false)==null,"unbreakable target has no ticks");
        check(ToolAssessment.estimatedTicks(0,3,true,true)==null,"air is not a completed mining task");
        check(ToolAssessment.estimatedTicks(Float.MAX_VALUE,Float.MIN_VALUE,true,false)==null,"overflow remains unknown");
        var damaged=candidate(3,12,true,2,true,true,0);
        check(ToolAssessment.recommend(List.of(damaged,diamond),3,defaults,false)==diamond,"near-broken fast tool is protected");
        check(ToolAssessment.recommend(List.of(damaged),3,new ToolAssessment.Policy("fastest_valid",1,"any"),false)==damaged,"explicit reserve may permit remaining2");
        var a=candidate(5,6,true,100,true,true,0);var b=candidate(24,6,true,100,true,true,0);
        check(ToolAssessment.recommend(List.of(a,b),24,defaults,false)==b,"equal speed keeps selected slot");
        check(ToolAssessment.recommend(List.of(a,b),0,defaults,false)==a,"remaining tie is stable by native slot");
        var unknown=candidate(6,100,null,100,true,false,0);var incomplete=candidate(7,200,true,100,false,true,0);
        check(ToolAssessment.recommend(List.of(unknown,incomplete,a),0,defaults,false)==a,"unknown/incomplete candidate is not recommended");
        check(ToolAssessment.recommend(List.of(unknown,incomplete),0,defaults,false)==null,"all unusable yields no recommendation");
        var conserve=new ToolAssessment.Policy("conserve_durability",2,"any");
        check(ToolAssessment.recommend(List.of(candidate(0,10,true,5,true,true,0),a),0,conserve,false)==a,"conserve compares durability first");
        check(ToolAssessment.recommend(List.of(axe,hand),10,conserve,false)==hand,"eligible non-damageable hand conserves tools");
        var silk=candidate(2,8,true,500,true,true,1);
        check(ToolAssessment.recommend(List.of(a,silk),0,new ToolAssessment.Policy("fastest_valid",2,"silk_touch"),false)==silk,"silk filters before speed");
        check(ToolAssessment.recommend(List.of(silk,a),0,new ToolAssessment.Policy("fastest_valid",2,"no_silk_touch"),false)==a,"no-silk avoids known changed drops");
        check(ToolAssessment.recommend(List.of(candidate(1,99,true,100,true,false,0)),0,new ToolAssessment.Policy("fastest_valid",2,"no_silk_touch"),false)==null,"unknown drops cannot satisfy explicit preference");
        var orePolicy=ResourceCatalog.discoveryPolicy(true);
        check(orePolicy.dropPreference().equals("no_silk_touch"),"ore discovery explicitly selects ordinary output tools");
        check(ToolAssessment.recommend(List.of(woodIron,goldIron,silk,iron),0,orePolicy,false)==iron,"ordinary ore policy rejects injected wood/gold ineligible facts and faster silk before comparing speed");
        ResourceCatalog.requireOrdinaryOreTool(true,iron);
        check(true,"known eligible ordinary ore tool passes final guard");
        errorCode("MISSING_TOOL",()->ResourceCatalog.requireOrdinaryOreTool(true,woodIron));
        errorCode("UNSUPPORTED",()->ResourceCatalog.requireOrdinaryOreTool(true,silk));
        errorCode("UNKNOWN",()->ResourceCatalog.requireOrdinaryOreTool(true,unknown));
        errorCode("UNKNOWN",()->ResourceCatalog.requireOrdinaryOreTool(true,candidate(1,99,true,100,true,false,0)));
        errorCode("UNKNOWN",()->ResourceCatalog.requireOrdinaryOreTool(true,incomplete));
        var fortune=new ToolAssessment.Candidate(25,obj("slot",25,"count",1),true,8,1000,true,true,0,3);
        ResourceCatalog.requireOrdinaryOreTool(true,fortune);
        check(ToolAssessment.recommend(List.of(iron,fortune),0,ResourceCatalog.discoveryPolicy(true),false)==fortune,"fortune remains eligible without predicting its variable yield");
        check(ToolAssessment.recommend(List.of(candidate(0,Float.POSITIVE_INFINITY,true,null,true,true,0)),0,defaults,false)==null,"infinite speed cannot win");
        check(ToolAssessment.policy(obj()).equals(defaults),"default policy is stable");
        errorCode("INVALID_ARGUMENT",()->ToolAssessment.policy(obj("policy","always_fast")));
        errorCode("INVALID_ARGUMENT",()->ToolAssessment.policy(obj("minRemainingDurability",1.5)));
        errorCode("INVALID_ARGUMENT",()->ToolAssessment.policy(obj("minRemainingDurability",-1)));
        errorCode("INVALID_ARGUMENT",()->ToolAssessment.policy(obj("dropPreference","fortune_only")));
        System.out.println("ToolAssessmentTest: "+checks+" checks passed (selection/estimates/native tier data; actual block qualification not tested)");
    }
}
