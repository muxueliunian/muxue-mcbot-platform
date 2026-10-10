package com.mcbot.servercontrol;

import java.util.*;
import com.mcbot.servercontrol.ArmourChoice.*;

/** The better-armour rule as plain values: order of the measures, equal, binding curse, empty slot, room, several candidates. */
final class ArmourChoiceTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static Piece piece(double armour,double toughness,int levels,int left){return new Piece(armour,toughness,levels,left,false);}
    private static Piece bound(Piece p){return new Piece(p.armour(),p.toughness(),p.enchantLevels(),p.durabilityLeft(),true);}
    private static Candidate chest(int slot,Piece piece){return new Candidate(slot,"minecraft:chestplate_"+slot,1,"chest",piece);}
    private static Assessment one(Candidate candidate,Map<String,Piece> worn,boolean free){return ArmourChoice.assess(List.of(candidate),worn,free).get(0);}

    static void run(){
        Piece iron=piece(6,0,0,200),diamond=piece(8,2,0,500),netherite=piece(8,3,0,600);
        Map<String,Piece> wearsIron=Map.of("chest",iron);
        // The reported case: iron on, diamond thrown.
        Assessment upgrade=one(chest(5,diamond),wearsIron,true);
        check(upgrade.verdict().equals("better")&&upgrade.reason().equals("better-stats"),"diamond over iron");
        check(one(chest(5,iron),Map.of("chest",diamond),true).verdict().equals("not-better")&&one(chest(5,iron),Map.of("chest",diamond),true).reason().equals("worse"),"iron under diamond");

        // Order of measures: armour, then toughness, then enchantment levels, then durability left.
        check(ArmourChoice.compare(piece(7,0,0,1),piece(6,9,9,999))>0,"armour first, whatever the rest");
        check(ArmourChoice.compare(piece(8,3,0,1),piece(8,2,9,999))>0,"toughness before enchantments");
        check(ArmourChoice.compare(piece(8,2,1,1),piece(8,2,0,999))>0,"enchantment levels before durability");
        check(ArmourChoice.compare(piece(8,2,1,300),piece(8,2,1,200))>0,"durability last");
        check(ArmourChoice.compare(piece(8,2,1,200),piece(8,2,1,200))==0,"all equal compares as 0");
        check(ArmourChoice.compare(netherite,diamond)>0&&ArmourChoice.compare(diamond,netherite)<0,"netherite over diamond by toughness");
        Assessment same=one(chest(5,iron),wearsIron,true);
        check(same.verdict().equals("not-better")&&same.reason().equals("same"),"exactly equal is not swapped");
        check(one(chest(5,piece(6,0,0,201)),wearsIron,true).verdict().equals("better"),"one more point of durability is better");

        // Empty slot: anything goes on, except a cursed piece.
        check(one(chest(5,piece(1,0,0,10)),Map.of(),true).verdict().equals("better")&&one(chest(5,piece(1,0,0,10)),Map.of(),true).reason().equals("slot-empty"),"empty part: wear it");
        Assessment cursedNew=one(chest(5,bound(netherite)),wearsIron,true);
        check(cursedNew.verdict().equals("blocked")&&cursedNew.reason().equals("new-binding"),"a new piece with binding is never put on, however good");
        check(one(chest(5,bound(iron)),Map.of(),true).verdict().equals("blocked"),"nor onto an empty slot");
        Assessment cursedWorn=one(chest(5,netherite),Map.of("chest",bound(iron)),true);
        check(cursedWorn.verdict().equals("blocked")&&cursedWorn.reason().equals("worn-binding"),"a worn piece with binding stays");

        // Room for the piece taken off: it goes where the new one was, so one piece always fits; a stack of two needs another slot.
        check(one(chest(5,diamond),wearsIron,false).verdict().equals("better"),"full inventory, single piece: swap in place");
        Candidate two=new Candidate(5,"minecraft:chestplate_5",2,"chest",diamond);
        Assessment full=one(two,wearsIron,false);
        check(full.verdict().equals("blocked")&&full.reason().equals("no-room"),"a stack of two with no free slot: no room for the old piece");
        check(one(two,wearsIron,true).verdict().equals("better")&&one(two,Map.of(),false).verdict().equals("better"),"free slot or empty part: fine");

        // Several candidates for one part: only the best is better; other parts are independent.
        Candidate helmet=new Candidate(7,"minecraft:diamond_helmet",1,"head",piece(3,2,0,300));
        List<Assessment> many=ArmourChoice.assess(List.of(chest(1,piece(7,0,0,300)),chest(2,diamond),helmet,chest(3,netherite)),Map.of("chest",iron,"head",piece(2,0,0,100)),true);
        check(many.get(0).verdict().equals("not-better")&&many.get(0).reason().equals("better-candidate"),"a better one for the same part exists");
        check(many.get(1).reason().equals("better-candidate")&&many.get(3).verdict().equals("better"),"netherite wins among iron-beating chestplates");
        check(many.get(2).verdict().equals("better"),"helmet decided on its own part");
        check(many.get(0).candidate().slot()==1&&many.get(3).candidate().slot()==3,"order of candidates kept");
        List<Assessment> allWorse=ArmourChoice.assess(List.of(chest(1,piece(5,0,0,300)),chest(2,piece(4,0,0,300))),wearsIron,true);
        check(allWorse.get(0).reason().equals("worse")&&allWorse.get(1).reason().equals("worse"),"none better: each says worse");

        // Shield: only into an empty off hand.
        Candidate shield=new Candidate(9,"minecraft:shield",1,"offhand",piece(0,0,0,336));
        check(one(shield,Map.of(),true).verdict().equals("better"),"shield into an empty off hand");
        Assessment taken=one(shield,Map.of("offhand",piece(0,0,0,336)),true);
        check(taken.verdict().equals("not-better")&&taken.reason().equals("offhand-occupied"),"an occupied off hand is left alone, even by a better shield");
        check(one(new Candidate(9,"minecraft:shield",1,"offhand",bound(piece(0,0,0,336))),Map.of(),true).verdict().equals("blocked"),"bound shield not put on");
        check(one(new Candidate(9,"minecraft:elytra",1,"mainhand",iron),Map.of(),true).reason().equals("not-armour"),"an unknown part is no candidate");

        check(ServerController.CAPABILITIES.contains("assess-armour"),"capability advertised");
        check(!ServerController.atomicAction("assess-armour"),"assess-armour is a read, never an action");
        check(ServerController.atomicAction("equip-item"),"equip-item stays an action");
        System.out.println("ArmourChoiceTest: "+checks+" checks passed");
    }
}
