package com.mcbot.servercontrol;

/** Core slot-click rules that adapted item-handler menus (hidden or protected machine slots) rely on. */
final class SlotClickRulesTest {
    private static int checks;
    private static void check(boolean ok,String message) {checks++;if(!ok)throw new AssertionError(message);}
    static void run() {
        check(SurvivalActions.slotClickAllowed(true,false,true),"empty active item-handler destination allows carried deposit despite no extraction permission");
        check(!SurvivalActions.slotClickAllowed(true,false,false),"protected occupied source remains rejected");
        check(!SurvivalActions.slotClickAllowed(false,true,false),"hidden occupied machine slot cannot be extracted");
        check(!SurvivalActions.slotClickAllowed(false,false,true),"hidden empty machine slot cannot receive carried items");
        check(SurvivalActions.slotClickAllowed(true,true,false),"ordinary pickup source remains allowed");
        System.out.println("SlotClickRulesTest: "+checks+" checks passed");
    }
}
