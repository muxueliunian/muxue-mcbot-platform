package com.mcbot.addon.ironfurnaces;

import java.util.*;
import net.neoforged.neoforge.items.SlotItemHandler;

public final class IronFurnaceAdapterTest {
    private static int checks;
    private static void check(boolean ok,String message) {checks++;if(!ok)throw new AssertionError(message);}
    private static List<IronFurnaceAdapter.NativeSlot> slots(Object machine,Object inventory) {
        List<IronFurnaceAdapter.NativeSlot> result=new ArrayList<>();Object placeholder=new Object();
        for(int i=0;i<19;i++) result.add(new IronFurnaceAdapter.NativeSlot(machine,i,19,IronFurnaceAdapter.machineSlotClass(i),null));
        for(int i=19;i<55;i++) result.add(new IronFurnaceAdapter.NativeSlot(placeholder,i<46?i-19+9:i-46,0,SlotItemHandler.class.getName(),inventory));
        return result;
    }
    public static void main(String[] args) {
        check(IronFurnaceAdapter.supportedIdentity("4.3.2","ironfurnaces:iron_furnace",IronFurnaceAdapter.BLOCK),"only pinned iron furnace identity accepted");
        check(!IronFurnaceAdapter.supportedIdentity("4.3.3","ironfurnaces:iron_furnace",IronFurnaceAdapter.BLOCK),"untested mod version rejected");
        check(!IronFurnaceAdapter.supportedIdentity("4.3.2","ironfurnaces:gold_furnace",IronFurnaceAdapter.BLOCK),"same namespace other furnace rejected");
        check(!IronFurnaceAdapter.supportedIdentity("4.3.2","ironfurnaces:iron_furnace",IronFurnaceAdapter.BLOCK+"Replacement"),"different runtime block class rejected");
        check(IronFurnaceAdapter.supportedMode(false,0,true,false,false,false),"idle normal furnace supported");
        check(!IronFurnaceAdapter.supportedMode(true,0,true,false,false,false),"lit machine rejected");
        check(!IronFurnaceAdapter.supportedMode(false,1,true,false,false,false),"changed block mode rejected");
        check(!IronFurnaceAdapter.supportedMode(false,0,false,true,false,false),"factory rejected");
        check(!IronFurnaceAdapter.supportedMode(false,0,false,false,true,false),"generator rejected");
        check(!IronFurnaceAdapter.supportedMode(false,0,true,false,false,true),"upgrade configuration view rejected");
        Object machine=new Object(),inventory=new Object(),other=new Object();
        List<IronFurnaceAdapter.NativeSlot> slots=slots(machine,inventory);
        check(IronFurnaceAdapter.verifiedContract(slots,inventory,41)==machine,"all 19 actual machine slots and 36 wrapped player slots verified");
        check(IronFurnaceAdapter.handlerSource(inventory,inventory,0,41).playerSlot()==0,"wrapped hotbar retains native index zero");
        check(IronFurnaceAdapter.handlerSource(inventory,inventory,35,41).playerSlot()==35,"wrapped player inventory retains native index35");
        check(IronFurnaceAdapter.handlerSource(other,inventory,0,41).source().equals("unknown"),"another inventory wrapper cannot masquerade as player");
        check(IronFurnaceAdapter.handlerSource(inventory,inventory,41,41).source().equals("unknown"),"out of range wrapper index rejected");
        check(IronFurnaceAdapter.verifiedContract(slots.subList(0,54),inventory,41)==null,"partial menu cannot use pinned contract");
        slots.set(2,new IronFurnaceAdapter.NativeSlot(other,2,19,IronFurnaceAdapter.machineSlotClass(2),null));
        check(IronFurnaceAdapter.verifiedContract(slots,inventory,41)==null,"machine slot backed by different entity rejected");
        slots=slots(machine,inventory);slots.set(13,new IronFurnaceAdapter.NativeSlot(machine,13,19,"unexpected.OutputSlot",null));
        check(IronFurnaceAdapter.verifiedContract(slots,inventory,41)==null,"changed hidden machine slot class rejected");
        slots=slots(machine,inventory);slots.set(46,new IronFurnaceAdapter.NativeSlot(other,1,0,SlotItemHandler.class.getName(),inventory));
        check(IronFurnaceAdapter.verifiedContract(slots,inventory,41)==null,"wrong native player hotbar index rejected");
        slots=slots(machine,inventory);slots.set(46,new IronFurnaceAdapter.NativeSlot(other,0,0,SlotItemHandler.class.getName(),other));
        check(IronFurnaceAdapter.verifiedContract(slots,inventory,41)==null,"foreign handler rejected even with correct index");
        check(McbotIronFurnaces.HINT.length()<=com.mcbot.servercontrol.api.McbotApi.HINT_MAX&&McbotIronFurnaces.HINT.chars().noneMatch(Character::isISOControl),"usage hint fits the core limit as plain text");
        System.out.println("IronFurnaceAdapterTest: "+checks+" checks passed");
    }
}
