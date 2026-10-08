package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.workstation.*;
import java.util.*;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.*;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * modify-item: work on one chosen item at an enchanting table, anvil, grindstone, smithing table, loom or
 * cartography table. The item is named by a reference from workstation-options (an exact stack), never picked by
 * the body itself. With preview the station is opened, the inputs put in, and what the game shows (result, level
 * cost, enchanting offers, loom patterns) is reported before everything is taken back. Without preview the same is
 * done and committed only when the levels it spends are within maxLevels and, when `expect` is given, the result
 * shown is still that one. Committing is the game's own: pressing the enchanting slot, or shift-clicking the result.
 */
final class ModifyTask extends StationJob {
    enum Kind { ENCHANT("enchant",VanillaWorkstations.ENCHANTING_TABLE),ANVIL("anvil",VanillaWorkstations.ANVIL),GRIND("grind",VanillaWorkstations.GRINDSTONE),
        SMITH("smith",VanillaWorkstations.SMITHING_TABLE),LOOM("loom",VanillaWorkstations.LOOM),CARTOGRAPHY("cartography",VanillaWorkstations.CARTOGRAPHY_TABLE);
        final String wire;final WorkstationAdapter adapter;
        Kind(String wire,WorkstationAdapter adapter){this.wire=wire;this.adapter=adapter;}
        static Kind of(String wire){for(Kind k:values())if(k.wire.equals(wire))return k;throw error("INVALID_ARGUMENT","action.kind must be enchant, anvil, grind, smith, loom or cartography");}
    }
    private final SubjectRefs refs;
    private Kind kind;
    private String subjectRef,withRef,rename,pattern,expect;
    private Item withItem,template,addition,dye,patternItem;
    private int option,maxLevels;
    private boolean preview;
    private ItemStack subjectBefore;

    ModifyTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session,SubjectRefs refs){super(operation,player,session);this.refs=refs;}
    String noStationCode(){return "NO_STATION";}
    private static String optional(JsonObject o,String key){return o.has(key)?string(o,key):null;}
    private Item optionalItem(JsonObject o,String key){String v=optional(o,key);return v==null?null:item(v);}
    private int plainCount(Item item){int n=0;Inventory inv=player.getInventory();for(int i=0;i<36;i++){ItemStack s=inv.getItem(i);if(plain(s)&&s.is(item))n+=s.getCount();}return n;}
    private void requirePlain(Item item,int n,String what) {
        if(item!=null&&plainCount(item)<n){failureDetail=obj("missing",List.of(obj("options",List.of(id(item)),"need",n,"have",plainCount(item))));throw error("MISSING_MATERIALS","No "+what+" "+id(item)+" in the inventory");}
    }

    @Override void begin() {
        JsonObject args=operation.args;JsonObject action=object(args,"action");
        kind=Kind.of(string(action,"kind"));subjectRef=string(args,"subject");
        preview=args.has("preview")&&bool(args,"preview");
        double levels=bounded(args,"maxLevels",0,0,39);if(levels!=Math.rint(levels))throw error("INVALID_ARGUMENT","maxLevels must be an integer");maxLevels=(int)levels;
        expect=optional(args,"expect");
        deadline=now()+(long)bounded(args,"timeoutMs",30_000,1000,120_000);
        int slot=refs.resolve(player,subjectRef);subjectBefore=player.getInventory().getItem(slot).copy();
        switch(kind) {
            case ENCHANT -> {
                if(!preview){if(!action.has("option"))throw error("INVALID_ARGUMENT","action.option (1..3, from the preview) is required");double o=bounded(action,"option",1,1,3);if(o!=Math.rint(o))throw error("INVALID_ARGUMENT","action.option must be 1, 2 or 3");option=(int)o;}
                requirePlain(Items.LAPIS_LAZULI,preview?1:option,"lapis");
            }
            case ANVIL -> {
                String with=optional(action,"with");rename=optional(action,"rename");
                if(with!=null){if(with.startsWith("item-")){withRef=with;if(refs.resolve(player,withRef)==slot)throw error("INVALID_ARGUMENT","with must be another item");}else{withItem=item(with);requirePlain(withItem,1,"material");}}
                if(rename!=null&&(rename.length()>50||rename.chars().anyMatch(c->c<32||c==127||c==167)))throw error("INVALID_ARGUMENT","rename must be up to 50 ordinary characters");
                if(with==null&&rename==null)throw error("INVALID_ARGUMENT","An anvil needs action.with (a material id or another item reference) and/or action.rename");
            }
            case GRIND -> { String with=optional(action,"with");if(with!=null){if(!with.startsWith("item-"))throw error("INVALID_ARGUMENT","grind with takes another item reference");withRef=with;if(refs.resolve(player,withRef)==slot)throw error("INVALID_ARGUMENT","with must be another item");} }
            case SMITH -> { template=item(string(action,"template"));addition=item(string(action,"addition"));requirePlain(template,1,"template");requirePlain(addition,1,"addition"); }
            case LOOM -> {
                dye=item(string(action,"dye"));requirePlain(dye,1,"dye");patternItem=optionalItem(action,"patternItem");requirePlain(patternItem,1,"pattern item");
                pattern=optional(action,"pattern");if(pattern!=null&&!pattern.contains(":"))pattern="minecraft:"+pattern;
                if(!preview&&pattern==null)throw error("INVALID_ARGUMENT","action.pattern (from the preview) is required");
            }
            case CARTOGRAPHY -> { withItem=item(string(action,"with"));requirePlain(withItem,1,"item"); }
        }
        findStations(List.of(kind.adapter),(a,s)->true);
    }

    private int putPlain(AbstractContainerMenu menu,int target,Item item,int n) {
        int put=0;Inventory inv=player.getInventory();
        for(int i=0;i<36&&put<n;i++){ItemStack s=inv.getItem(i);if(plain(s)&&s.is(item))put+=transfer(player,menu,i,target,n-put);}
        return put;
    }
    /** Take every input back unchanged and keep the item references pointing at those exact stacks. */
    private boolean restore(AbstractContainerMenu menu){boolean back=takeBack(menu,inputs());refs.rebind(player,subjectRef);if(withRef!=null)refs.rebind(player,withRef);return back;}
    private List<Integer> inputs(){List<Integer> all=new ArrayList<>();for(Port p:List.of(Port.SUBJECT,Port.CATALYST,Port.INGREDIENT))all.addAll(layout.slots(p));return all;}

    @Override void opened(AbstractContainerMenu menu,StationLayout layout) {
        for(int s:inputs())if(!menu.getSlot(s).getItem().isEmpty()){closeMenu(player);skip("busy");return;}
        int subjectSlot=layout.slot(Port.SUBJECT);List<Integer> catalysts=layout.slots(Port.CATALYST);int resultSlot=layout.slot(Port.RESULT);
        // The referenced items must still be exactly what was referenced.
        int from=refs.resolve(player,subjectRef);int withFrom=withRef==null?-1:refs.resolve(player,withRef);
        if(transfer(player,menu,from,subjectSlot,1)!=1){restore(menu);fail("RECIPE_REFUSED","The station did not accept "+ItemDescriptions.key(subjectBefore),obj());return;}
        boolean ok=true;
        switch(kind) {
            case ENCHANT -> ok=putPlain(menu,catalysts.getFirst(),Items.LAPIS_LAZULI,3)>0;
            case ANVIL -> { if(withFrom>=0)ok=transfer(player,menu,withFrom,catalysts.getFirst(),player.getInventory().getItem(withFrom).getCount())>0;else if(withItem!=null)ok=putPlain(menu,catalysts.getFirst(),withItem,64)>0;
                            if(ok&&rename!=null)NativeWorkstation.rename(player,rename); }
            case GRIND -> { if(withFrom>=0)ok=transfer(player,menu,withFrom,catalysts.getFirst(),1)==1; }
            case SMITH -> ok=putPlain(menu,catalysts.get(0),template,1)==1&&putPlain(menu,catalysts.get(1),addition,1)==1;
            case LOOM -> ok=putPlain(menu,catalysts.get(0),dye,1)==1&&(patternItem==null||putPlain(menu,catalysts.get(1),patternItem,1)==1);
            case CARTOGRAPHY -> ok=putPlain(menu,catalysts.getFirst(),withItem,1)==1;
        }
        if(!ok){restore(menu);fail("RECIPE_REFUSED","The station did not take the inputs",obj());return;}
        WorkstationAdapter adapter=station.adapter();
        List<StationOption> options=safely(()->adapter.options(player,menu),List.<StationOption>of());
        if(kind==Kind.LOOM&&pattern!=null) {
            int button=-1;for(StationOption o:options)if(o.id().equals(pattern))button=o.button();
            if(button<0){JsonObject r=obj("options",optionIds(options));restore(menu);fail("NO_SUCH_OPTION","The loom does not offer "+pattern+" with these inputs",r);return;}
            button(player,menu,button);
        }
        ItemStack shown=resultSlot<0?ItemStack.EMPTY:menu.getSlot(resultSlot).getItem().copy();
        int cost=safely(()->adapter.levelCost(menu),0);
        JsonObject result=obj("kind",kind.wire,"station",pos(station.pos()),"subject",ItemDescriptions.describe(subjectBefore),"playerLevels",player.experienceLevel);
        if(kind==Kind.ENCHANT)result.add("options",enchantOptions(options));
        else if(kind==Kind.LOOM&&pattern==null)result.add("options",optionIds(options));
        if(resultSlot>=0)result.add("result",shown.isEmpty()?JsonNull.INSTANCE:ItemDescriptions.describe(shown));
        if(kind==Kind.ANVIL)result.addProperty("levelCost",cost);
        if(preview) {
            boolean back=restore(menu);if(!back)result.addProperty("leftInStation",true);
            result.addProperty("preview",true);
            succeed("Preview at the "+kind.wire+" station: "+(kind==Kind.ENCHANT?options.size()+" offers":shown.isEmpty()?"no result for these inputs":ItemDescriptions.key(shown)+(cost>0?" for "+cost+" levels":"")),result);return;
        }
        if(kind==Kind.ENCHANT){commitEnchant(menu,options,result,subjectSlot);return;}
        // Result stations: the game shows the result; taking it is the commit.
        if(shown.isEmpty()){restore(menu);fail("RECIPE_REFUSED","The station shows no result for these inputs",result);return;}
        if(expect!=null&&!expect.equals(ItemDescriptions.key(shown))){restore(menu);fail("PREVIEW_CHANGED","The result is now "+ItemDescriptions.key(shown)+", not "+expect,result);return;}
        if(cost>maxLevels){restore(menu);fail("OVER_LIMIT","It costs "+cost+" levels, more than maxLevels "+maxLevels,result);return;}
        if(cost>player.experienceLevel){restore(menu);fail("NOT_ENOUGH_LEVELS","It costs "+cost+" levels; the body has "+player.experienceLevel,result);return;}
        String key=ItemDescriptions.key(shown);int had=ItemDescriptions.counts(player.getInventory()).getOrDefault(key,0);
        quickMove(player,menu,resultSlot);
        int got=ItemDescriptions.counts(player.getInventory()).getOrDefault(key,0)-had;
        boolean back=takeBack(menu,inputs());if(!back)result.addProperty("leftInStation",true);
        refs.forget(subjectRef);if(withRef!=null)refs.forget(withRef);
        if(got<shown.getCount()){
            if(menu.getSlot(resultSlot).getItem().isEmpty()){unknown("UNKNOWN_RESULT","The result slot emptied but the result did not arrive in the inventory; observe the inventory and do not repeat",result);return;}
            fail("INVENTORY_FULL","The result did not arrive in the inventory",result);return;
        }
        result.addProperty("levelsSpent",levelsBefore-player.experienceLevel);
        succeed("Made "+key,result);
    }
    private static JsonArray optionIds(List<StationOption> options){JsonArray a=new JsonArray();for(StationOption o:options)a.add(o.id());return a;}
    private JsonArray enchantOptions(List<StationOption> options) {
        JsonArray a=new JsonArray();
        for(StationOption o:options)a.add(obj("option",o.button()+1,"requiresLevel",o.levels(),"spendsLevels",o.button()+1,"lapis",o.button()+1,"shows",o.hint()));
        return a;
    }
    private void commitEnchant(AbstractContainerMenu menu,List<StationOption> options,JsonObject result,int subjectSlot) {
        StationOption chosen=null;for(StationOption o:options)if(o.button()==option-1)chosen=o;
        if(chosen==null){restore(menu);fail("NO_SUCH_OPTION","Offer "+option+" is not available for this item here",result);return;}
        if(option>maxLevels){restore(menu);fail("OVER_LIMIT","Offer "+option+" spends "+option+" levels, more than maxLevels "+maxLevels,result);return;}
        if(player.experienceLevel<chosen.levels()){restore(menu);fail("NOT_ENOUGH_LEVELS","Offer "+option+" needs level "+chosen.levels()+"; the body has "+player.experienceLevel,result);return;}
        int lapis=menu.getSlot(layout.slots(Port.CATALYST).getFirst()).getItem().getCount();
        if(lapis<option){restore(menu);fail("MISSING_MATERIALS","Offer "+option+" needs "+option+" lapis; "+lapis+" went in",result);return;}
        String beforeKey=ItemDescriptions.key(menu.getSlot(subjectSlot).getItem());
        button(player,menu,option-1);
        ItemStack after=menu.getSlot(subjectSlot).getItem().copy();
        boolean changed=!after.isEmpty()&&!ItemDescriptions.key(after).equals(beforeKey);
        boolean back=takeBack(menu,inputs());if(!back)result.addProperty("leftInStation",true);
        refs.forget(subjectRef);
        result.add("result",ItemDescriptions.describe(after));result.addProperty("levelsSpent",levelsBefore-player.experienceLevel);
        if(!changed){fail("ENCHANT_REFUSED","The table did not enchant the item",result);return;}
        succeed("Enchanted: "+ItemDescriptions.key(after),result);
    }
}
