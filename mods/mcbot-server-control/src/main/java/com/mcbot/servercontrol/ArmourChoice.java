package com.mcbot.servercontrol;

import java.util.*;

/**
 * Whether a piece of armour in the inventory should replace the one worn (capability assess-armour). The only place
 * that decides "better": the runtime asks and never compares gear itself. Plain values only; reading the native stacks
 * is in {@link ArmourAssessment}.
 *
 * Parts are head, chest, legs, feet (vanilla humanoid armour) and offhand (a shield into an empty off hand). Better is,
 * in order: more armour points, more toughness, more total enchantment levels (curses not counted), more durability left; all equal is not
 * better. A piece with the curse of binding is never put on and never taken off.
 */
final class ArmourChoice {
    static final List<String> PARTS=List.of("head","chest","legs","feet","offhand");
    private ArmourChoice() {}

    /** One piece as it matters for comparing: armour points and toughness (the attribute values for its slot), summed enchantment levels, durability left (Integer.MAX_VALUE if it cannot break), binding curse. */
    record Piece(double armour,double toughness,int enchantLevels,int durabilityLeft,boolean binding) {}
    /** A main-inventory stack that could be worn: slot, id, stack size, the part it goes on. */
    record Candidate(int slot,String id,int count,String part,Piece piece) {}
    /** better: wear it. not-better: leave it (same, worse, a better candidate for that part exists, off hand taken). blocked: cannot or must not (worn-binding, new-binding, no-room). */
    record Assessment(Candidate candidate,String verdict,String reason) {}

    /** Positive when a is better than b, 0 when equal in all four measures. */
    static int compare(Piece a,Piece b) {
        int result=Double.compare(a.armour(),b.armour());
        if(result==0)result=Double.compare(a.toughness(),b.toughness());
        if(result==0)result=Integer.compare(a.enchantLevels(),b.enchantLevels());
        if(result==0)result=Integer.compare(a.durabilityLeft(),b.durabilityLeft());
        return result;
    }

    /**
     * worn maps part to what is worn there (absent: empty). hasFreeSlot: a main inventory slot is empty. The piece taken
     * off goes into the slot the new one leaves, so a single piece always has room; a stack of several needs another slot.
     * Per part only the best candidate can be "better"; the others say so. Results keep the order of candidates.
     */
    static List<Assessment> assess(List<Candidate> candidates,Map<String,Piece> worn,boolean hasFreeSlot) {
        Map<Candidate,Assessment> own=new IdentityHashMap<>();
        Map<String,Candidate> best=new HashMap<>();
        for(Candidate candidate:candidates) {
            Piece current=worn.get(candidate.part());
            Assessment verdict;
            if(!PARTS.contains(candidate.part()))verdict=new Assessment(candidate,"not-better","not-armour");
            else if(candidate.piece().binding())verdict=new Assessment(candidate,"blocked","new-binding");
            else if(candidate.part().equals("offhand"))verdict=current==null?new Assessment(candidate,"better","slot-empty"):new Assessment(candidate,"not-better","offhand-occupied");
            else if(current==null)verdict=new Assessment(candidate,"better","slot-empty");
            else if(current.binding())verdict=new Assessment(candidate,"blocked","worn-binding");
            else if(candidate.count()>1&&!hasFreeSlot)verdict=new Assessment(candidate,"blocked","no-room");
            else{
                int order=compare(candidate.piece(),current);
                verdict=order>0?new Assessment(candidate,"better","better-stats"):new Assessment(candidate,"not-better",order==0?"same":"worse");
            }
            own.put(candidate,verdict);
            if(verdict.verdict().equals("better")) {
                Candidate leader=best.get(candidate.part());
                if(leader==null||compare(candidate.piece(),leader.piece())>0)best.put(candidate.part(),candidate);
            }
        }
        List<Assessment> result=new ArrayList<>();
        for(Candidate candidate:candidates) {
            Assessment verdict=own.get(candidate);
            if(verdict.verdict().equals("better")&&best.get(candidate.part())!=candidate)verdict=new Assessment(candidate,"not-better","better-candidate");
            result.add(verdict);
        }
        return result;
    }
}
