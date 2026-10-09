package com.mcbot.servercontrol;

import com.mcbot.servercontrol.api.McbotApi;
import com.mcbot.servercontrol.api.workstation.Port;
import com.mcbot.servercontrol.api.workstation.StationLayout;
import com.mcbot.servercontrol.platform.LoaderPlatform;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.RecipeType;

/** Workstation core pieces that need no running game: material allocation, port layouts, loader version pins. */
final class WorkstationCoreTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void refused(Runnable action,String message){checks++;try{action.run();throw new AssertionError(message);}catch(IllegalArgumentException expected){}}
    private static MaterialAllocator.Source<String> src(int slot,String kind,int count){return new MaterialAllocator.Source<>(slot,kind,kind,count,64);}
    private static Predicate<String> is(String... kinds){Set<String> set=Set.of(kinds);return set::contains;}

    static void run() {
        // Allocation: one kind per cell, gathered from several slots, fullest first.
        List<MaterialAllocator.Source<String>> inv=List.of(src(0,"oak_planks",3),src(1,"oak_planks",5),src(2,"stick",8));
        var plan=MaterialAllocator.allocate(List.of(is("oak_planks","birch_planks"),is("stick")),inv,6);
        check(plan!=null&&plan.get(0).equals(Map.of(1,5,0,1))&&plan.get(1).equals(Map.of(2,6)),"planks from the fullest slot first, then the next; sticks from one slot: "+plan);
        check(MaterialAllocator.allocate(List.of(is("oak_planks"),is("oak_planks")),inv,5)==null,"two cells of 5 cannot share 8 planks");
        check(MaterialAllocator.feasible(List.of(is("oak_planks"),is("oak_planks")),inv,5)==4,"largest feasible round is 4");
        var empty=MaterialAllocator.allocate(Arrays.asList(is("stick"),null,is("stick")),inv,2);
        check(empty!=null&&empty.get(1).isEmpty()&&empty.get(0).equals(Map.of(2,2))&&empty.get(2).equals(Map.of(2,2)),"empty cells take nothing; one slot can feed two cells");
        // A cell takes one kind only: 3 oak + 3 birch do not make a cell of 4.
        var mixed=List.of(src(0,"oak_planks",3),src(1,"birch_planks",3));
        check(MaterialAllocator.allocate(List.of(is("oak_planks","birch_planks")),mixed,4)==null,"kinds are never mixed in one cell");
        check(MaterialAllocator.allocate(List.of(is("oak_planks","birch_planks")),mixed,3)!=null,"either kind alone fills a cell of 3");
        // A stack that cannot hold `crafts` items (max stack 16) cannot feed a cell crafted 20 times.
        var eggs=List.of(new MaterialAllocator.Source<>(0,"egg","egg",16,16),new MaterialAllocator.Source<>(1,"egg","egg",16,16));
        check(MaterialAllocator.allocate(List.of(is("egg")),eggs,20)==null&&MaterialAllocator.feasible(List.of(is("egg")),eggs,20)==16,"a cell never holds more than the item's stack size");
        check(MaterialAllocator.allocate(List.of(is("stick")),inv,0)==null,"zero crafts is never a plan");
        // Global choice: the any-planks cell must leave the only oak to the oak-only cell.
        var one=List.of(src(0,"oak_planks",1),src(1,"birch_planks",1));
        var global=MaterialAllocator.allocate(List.of(is("oak_planks","birch_planks"),is("oak_planks")),one,1);
        check(global!=null&&global.get(0).equals(Map.of(1,1))&&global.get(1).equals(Map.of(0,1)),"most constrained cell picks first: "+global);
        var three=List.of(src(0,"oak_planks",2),src(1,"birch_planks",1));
        check(MaterialAllocator.allocate(List.of(is("oak_planks","birch_planks"),is("oak_planks","birch_planks"),is("oak_planks")),three,1)!=null,"backtracks to fit 2 oak + 1 birch over three cells");
        check(MaterialAllocator.allocate(List.of(is("oak_planks"),is("oak_planks"),is("oak_planks")),three,1)==null,"three oak cells with two oak fail");

        // Item references: unknown or someone else's never resolve.
        SubjectRefs refs=new SubjectRefs(()->0L);UUID me=UUID.randomUUID();
        checks++;try{refs.resolve(me,"item-nothere",slot->null);throw new AssertionError("unknown ref resolved");}catch(Protocol.Error e){if(!e.code.equals("STALE_SUBJECT"))throw e;}

        // Layouts: each slot in one port, grids complete.
        StationLayout table=StationLayout.grid(0,1,3,3);
        check(table.slot(Port.RESULT)==0&&table.slots(Port.INGREDIENT).equals(List.of(1,2,3,4,5,6,7,8,9))&&table.isGrid(),"3x3 grid layout");
        StationLayout furnace=StationLayout.processor(0,1,2);
        check(furnace.slot(Port.FUEL)==1&&!furnace.isGrid()&&furnace.slot(Port.CONTAINER)==-1,"processor layout, absent port is -1");
        check(StationLayout.processor(0,-1,1).slots(Port.FUEL).isEmpty(),"a processor without fuel has no fuel port");
        refused(()->new StationLayout(Map.of(Port.INGREDIENT,List.of(0),Port.RESULT,List.of(0)),0,0),"a slot cannot be in two ports");
        refused(()->new StationLayout(Map.of(Port.INGREDIENT,List.of(1,2,3),Port.RESULT,List.of(0)),2,2),"a 2x2 grid needs 4 cells");
        refused(()->new StationLayout(Map.of(Port.RESULT,List.of(-1)),0,0),"negative slots are refused");

        // Loader pins: an adapter's versionsMatch follows the running loader, an unknown loader is never supported.
        LoaderPlatform previous=LoaderPlatform.installedOrNull();
        try {
            LoaderPlatform.install(fake("neoforge","neoforge",Map.of("minecraft","1.21.1","neoforge","21.1.217","ironfurnaces","4.3.2")));
            check(McbotApi.platformMatches()&&McbotApi.versionsMatch("ironfurnaces","4.3.2"),"pinned NeoForge matches");
            check(!McbotApi.versionsMatch("ironfurnaces","4.3.1"),"other mod versions do not");
            LoaderPlatform.install(fake("neoforge","neoforge",Map.of("minecraft","1.21.1","neoforge","21.1.229","ironfurnaces","4.3.2")));
            check(McbotApi.platformMatches()&&McbotApi.versionsMatch("ironfurnaces","4.3.2"),"a newer NeoForge 21.1 build is supported");
            for(String older:new String[]{"21.1.216","21.1.99","21.2.5","21.10.300","","beta"}) {
                LoaderPlatform.install(fake("neoforge","neoforge",Map.of("minecraft","1.21.1","neoforge",older)));
                check(!McbotApi.platformMatches(),"NeoForge '"+older+"' is not a supported build");
            }
            LoaderPlatform.install(fake("neoforge","neoforge",Map.of("minecraft","1.21.1","neoforge","21.1.230-beta")));
            check(McbotApi.platformMatches(),"a suffixed build on the line counts by its number");
            LoaderPlatform.install(fake("neoforge","neoforge",Map.of("minecraft","1.21.2","neoforge","21.1.229")));
            check(!McbotApi.platformMatches(),"another Minecraft version is not supported");
            LoaderPlatform.install(fake("fabric","fabricloader",Map.of("minecraft","1.21.1","fabricloader","0.16.5","ironfurnaces","4.3.2")));
            check(!McbotApi.versionsMatch("ironfurnaces","4.3.2"),"a loader without a pin is not supported yet");
        } finally { if(previous!=null)LoaderPlatform.install(previous); }
        System.out.println("WorkstationCoreTest: "+checks+" checks passed (allocation, port layouts, loader pins)");
    }
    private static LoaderPlatform fake(String loader,String modId,Map<String,String> versions) {
        return new LoaderPlatform() {
            public String loader(){return loader;}
            public String loaderModId(){return modId;}
            public String modVersion(String id){return versions.getOrDefault(id,"");}
            public int burnTime(ItemStack stack,RecipeType<?> type){return 0;}
        };
    }
}
