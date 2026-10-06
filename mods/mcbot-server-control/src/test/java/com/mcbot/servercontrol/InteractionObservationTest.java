package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

final class InteractionObservationTest {
    private static int checks;
    private static void check(boolean condition,String message) {checks++;if(!condition)throw new AssertionError(message);}
    private static void invalid(JsonObject params) {
        checks++;
        try {NearbyBlocks.options(params);throw new AssertionError("Expected invalid parameters");}
        catch(Protocol.Error failure) {if(!failure.code.equals("INVALID_ARGUMENT"))throw failure;}
    }
    static int run() {
        NearbyBlocks.Options defaults=NearbyBlocks.options(obj());
        check(defaults.radius()==4&&defaults.maxResults()==8&&defaults.centerPlayer()==null,"bounded default discovery");
        NearbyBlocks.Options limits=NearbyBlocks.options(obj("radius",8,"maxResults",16,"centerPlayer","muxue"));
        check(limits.radius()==8&&limits.maxResults()==16&&limits.centerPlayer().equals("muxue"),"explicit player center and maximum bounds");
        for(JsonObject params:List.of(obj("radius",0),obj("radius",17),obj("radius",1.5),obj("maxResults",0),obj("maxResults",17),obj("maxResults",1.5),obj("centerPlayer",true))) invalid(params);
        check(NearbyBlocks.options(obj("radius",16)).radius()==16&&NearbyBlocks.MAX_VISITED==5445&&NearbyBlocks.VERTICAL_RADIUS==2,"fixed scan bound up to sixteen blocks");

        Object player=new Object(),storage=new Object(),other=new Object();
        List<MenuSlotSources.BackingSlot> slots=new ArrayList<>();
        for(int i=0;i<5;i++) slots.add(new MenuSlotSources.BackingSlot(storage,i,5));
        check(MenuSlotSources.verifiedBacking(slots,player,5)==storage,"actual storage identity verified against native contract");
        slots.addFirst(new MenuSlotSources.BackingSlot(player,7,41));
        check(MenuSlotSources.verifiedBacking(slots,player,5)==null,"changed menu prefix does not imply storage");
        var playerSlot=MenuSlotSources.classify(slots.getFirst(),player,41,storage);
        check(playerSlot.source().equals("player")&&playerSlot.playerSlot()==7,"player ownership uses identity even at first menu slot");
        slots.removeFirst();slots.set(4,new MenuSlotSources.BackingSlot(other,4,5));
        check(MenuSlotSources.verifiedBacking(slots,player,5)==null,"mixed storage contract remains unknown");
        slots.set(4,new MenuSlotSources.BackingSlot(storage,3,5));
        check(MenuSlotSources.verifiedBacking(slots,player,5)==null,"wrong native storage index remains unknown");
        check(MenuSlotSources.classify(new MenuSlotSources.BackingSlot(storage,2,5),player,41,storage).source().equals("container"),"confirmed storage source");
        check(MenuSlotSources.classify(new MenuSlotSources.BackingSlot(other,2,5),player,41,storage).source().equals("unknown"),"other backing container cannot masquerade as storage");
        check(MenuSlotSources.classify(new MenuSlotSources.BackingSlot(player,100,41),player,41,storage).source().equals("unknown"),"invalid player native index is unknown");
        var hotbar=MenuSlotSources.classify(new MenuSlotSources.BackingSlot(player,0,41),player,41,storage);
        check(hotbar.source().equals("player")&&hotbar.playerSlot()==0,"native hotbar index retained independent of menu position");
        System.out.println("InteractionObservationTest: "+checks+" checks passed");return checks;
    }
}
