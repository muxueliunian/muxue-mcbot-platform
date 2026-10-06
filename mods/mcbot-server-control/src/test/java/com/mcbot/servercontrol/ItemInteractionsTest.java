package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.world.item.ItemStack;
import static com.mcbot.servercontrol.Protocol.*;

/** Offline checks of interaction registration, held rules and receipt classification; no Minecraft launch. */
final class ItemInteractionsTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static JsonObject stack(int slot,String id,int count,JsonObject components){
        return count==0?obj("slot",slot,"id","minecraft:air","count",0,"components",obj()):obj("slot",slot,"id",id,"count",count,"components",components,"maxStackSize",64);
    }
    private static JsonObject snapshot(String level,JsonObject... slots){
        JsonArray inventory=new JsonArray();for(JsonObject slot:slots)inventory.add(slot);
        JsonObject result=obj("summary",obj(),"inventory",inventory,"menu","none","drops",new JsonArray());
        result.add("block",obj("id","minecraft:composter","properties",obj("level",level)));
        return result;
    }
    private record Fake(String id,String kind,boolean installed,boolean emptyHand) implements ItemInteractions.Interaction {
        public boolean accepts(ItemStack held){return true;}
        public ItemInteractions.Expected expected(){return new ItemInteractions.Expected(0,0,false,Set.of(),Set.of(),Set.of(),false);}
    }
    static void run() {
        ItemInteractions.Expected composter=ItemInteractions.COMPOSTER.expected();
        var consistent=(java.util.function.BiPredicate<JsonObject,JsonObject>)ItemInteractions::composterLevelStep;
        JsonObject seeds=stack(2,"minecraft:wheat_seeds",5,obj()),other=stack(3,"minecraft:dirt",1,obj());

        // Receipt classification
        var none=ItemInteractions.judge(snapshot("2",seeds,other),snapshot("2",seeds,other),2,composter,consistent);
        check(none.status().equals("failed")&&"NO_EFFECT".equals(none.code()),"no observable change is the only failed receipt");
        var levelUp=ItemInteractions.judge(snapshot("2",seeds,other),snapshot("3",stack(2,"minecraft:wheat_seeds",4,obj()),other),2,composter,consistent);
        check(levelUp.status().equals("succeeded")&&levelUp.consumed()==1,"one consumed and level +1 is confirmed");
        var chanceMiss=ItemInteractions.judge(snapshot("2",seeds,other),snapshot("2",stack(2,"minecraft:wheat_seeds",4,obj()),other),2,composter,consistent);
        check(chanceMiss.status().equals("succeeded"),"consumed with unchanged level is an allowed composter outcome");
        var lastOne=ItemInteractions.judge(snapshot("0",stack(2,"minecraft:wheat_seeds",1,obj())),snapshot("1",stack(2,"minecraft:air",0,obj())),2,composter,consistent);
        check(lastOne.status().equals("succeeded")&&lastOne.consumed()==1,"consuming the last held item empties the slot");
        var jump=ItemInteractions.judge(snapshot("2",seeds),snapshot("4",stack(2,"minecraft:wheat_seeds",4,obj())),2,composter,consistent);
        check(jump.status().equals("unknown"),"adapter value check rejects a two-level jump");
        var levelOnly=ItemInteractions.judge(snapshot("2",seeds),snapshot("3",seeds),2,composter,consistent);
        check(levelOnly.status().equals("unknown"),"level change without the required consumption is unknown");
        var two=ItemInteractions.judge(snapshot("2",seeds),snapshot("3",stack(2,"minecraft:wheat_seeds",3,obj())),2,composter,consistent);
        check(two.status().equals("unknown"),"consuming more than declared is unknown");
        var sideEffect=ItemInteractions.judge(snapshot("2",seeds,other),snapshot("3",stack(2,"minecraft:wheat_seeds",4,obj()),stack(3,"minecraft:dirt",2,obj())),2,composter,consistent);
        check(sideEffect.status().equals("unknown")&&sideEffect.unexpected().toString().contains("slot 3"),"an undeclared inventory gain is unknown and named");
        JsonObject replaced=snapshot("2",stack(2,"minecraft:wheat_seeds",4,obj()));replaced.getAsJsonObject("block").addProperty("id","minecraft:dirt");
        check(ItemInteractions.judge(snapshot("2",seeds),replaced,2,composter,consistent).status().equals("unknown"),"block replacement is outside the envelope");
        JsonObject opened=snapshot("3",stack(2,"minecraft:wheat_seeds",4,obj()));opened.addProperty("menu","minecraft:generic_9x3");
        check(ItemInteractions.judge(snapshot("2",seeds),opened,2,composter,consistent).status().equals("unknown"),"an undeclared menu is unknown");
        JsonObject dropped=snapshot("3",stack(2,"minecraft:wheat_seeds",4,obj()));
        dropped.getAsJsonArray("drops").add(obj("entityId",UUID.randomUUID().toString(),"stack",obj("id","minecraft:bone_meal","count",1,"components",obj())));
        check(ItemInteractions.judge(snapshot("2",seeds),dropped,2,composter,consistent).status().equals("unknown"),"an undeclared new drop is unknown");
        JsonObject named=stack(2,"minecraft:wheat_seeds",4,obj("minecraft:custom_name",obj("type","string","value","x")));
        check(ItemInteractions.judge(snapshot("2",seeds),snapshot("3",named),2,composter,consistent).status().equals("unknown"),"changed held components are unknown");

        // Declared gains, damage and menus for adapter interactions
        JsonObject shovel=stack(0,"example:shovel",1,obj("minecraft:damage",obj("type","int","value",0)));
        JsonObject worn=stack(0,"example:shovel",1,obj("minecraft:damage",obj("type","int","value",1)));
        var stir=new ItemInteractions.Expected(0,0,true,Set.of(),Set.of("stirs"),Set.of(),false);
        JsonObject b=snapshot("0",shovel),a=snapshot("0",worn);b.add("summary",obj("stirs",1));a.add("summary",obj("stirs",2));
        check(ItemInteractions.judge(b,a,0,stir,(x,y)->true).status().equals("succeeded"),"declared tool damage and summary change are confirmed");
        var noDamage=new ItemInteractions.Expected(0,0,false,Set.of(),Set.of("stirs"),Set.of(),false);
        check(ItemInteractions.judge(b,a,0,noDamage,(x,y)->true).status().equals("unknown"),"undeclared tool damage is unknown");
        var takeOut=new ItemInteractions.Expected(0,0,false,Set.of(),Set.of(),Set.of("example:dish"),false);
        var gainedDish=ItemInteractions.judge(snapshot("0",stack(0,"minecraft:air",0,obj())),snapshot("0",stack(0,"example:dish",1,obj())),0,takeOut,(x,y)->true);
        check(gainedDish.status().equals("succeeded")&&gainedDish.gained().size()==1,"declared product gain into the empty hand is confirmed");
        var menu=new ItemInteractions.Expected(0,0,false,Set.of(),Set.of(),Set.of(),true);
        JsonObject menuAfter=snapshot("0",shovel);menuAfter.addProperty("menu","example:backpack");
        check(ItemInteractions.judge(snapshot("0",shovel),menuAfter,0,menu,(x,y)->true).status().equals("succeeded"),"declared menu opening is within the envelope (menu contract checked separately)");

        // Held rules: empty hand is never a fallback
        ItemInteractions.requireHeld(false,false,false,true);checks++;
        errorCode("UNSUPPORTED",()->ItemInteractions.requireHeld(true,false,true,false));
        errorCode("UNSUPPORTED",()->ItemInteractions.requireHeld(false,true,true,false));
        errorCode("UNSUPPORTED",()->ItemInteractions.requireHeld(false,false,true,false));
        errorCode("UNSUPPORTED",()->ItemInteractions.requireHeld(false,false,false,false));
        ItemInteractions.requireHeld(true,true,true,false);checks++;
        errorCode("STALE_ITEM",()->ItemInteractions.requireHeld(true,true,false,false));

        // Registration and advertised capabilities
        List<ItemInteractions.Interaction> base=ItemInteractions.installed(List.of(ItemInteractions.COMPOSTER));
        check(ItemInteractions.capabilities(base).equals(List.of("use-item-on-block")),"vanilla composter advertises block use only");
        check(ItemInteractions.ids(base).toString().equals("[\"minecraft:composter/add\"]"),"advertised interaction IDs");
        Fake absent=new Fake("example:pot/add","block",false,false),bag=new Fake("example:backpack/open","item",true,false);
        ItemInteractions.Interaction broken=new ItemInteractions.Interaction(){
            public String id(){return "example:broken";} public String kind(){return "block";} public boolean emptyHand(){return false;}
            public boolean accepts(ItemStack held){return true;} public ItemInteractions.Expected expected(){return absent.expected();}
            public boolean installed(){throw new LinkageError("changed mod");}
        };
        List<ItemInteractions.Interaction> mixed=ItemInteractions.installed(List.of(ItemInteractions.COMPOSTER,absent,bag,broken));
        check(mixed.size()==2&&ItemInteractions.capabilities(mixed).equals(List.of("use-item-on-block","use-item")),"absent or broken mods are excluded; item kind adds use-item");
        check(ItemInteractions.capabilities(List.of()).isEmpty(),"no interactions means no capability");
        errorCode("UNSUPPORTED",()->ItemInteractions.require(mixed,"example:pot/add","block"));
        errorCode("UNSUPPORTED",()->ItemInteractions.require(mixed,"example:backpack/open","block"));
        check(ItemInteractions.require(mixed,"minecraft:composter/add","block")==ItemInteractions.COMPOSTER,"registered block interaction resolves");
        check(ServerController.atomicAction("use-item-on-block")&&!ServerController.atomicAction("use-item"),"act accepts only advertised interaction actions");
        System.out.println("ItemInteractionsTest: "+checks+" checks passed (registration, held rules and receipt classification; no Minecraft launch/native interaction)");
    }
}
