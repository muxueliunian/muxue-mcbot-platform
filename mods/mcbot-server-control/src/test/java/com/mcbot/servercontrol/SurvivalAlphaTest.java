package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static com.mcbot.servercontrol.Protocol.*;

/** Offline checks of production read degradation, native slot mapping, and the native-Finish use tracker. */
final class SurvivalAlphaTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static JsonObject stack(String id,int count){return count==0?obj("id","minecraft:air","count",0,"components",obj()):obj("id",id,"count",count,"components",obj(),"maxStackSize",64);}
    private static final class View implements NativeFoodUse.View {
        int selected=2,food=10,stops;float saturation=1;boolean using=true,mainHand=true,allowed=true,inventoryFault;
        JsonObject hand=stack("minecraft:apple",3);
        Runnable stopCallback;
        public void guard(){if(!allowed)throw error("LEASE_LOST","Injected lost native permission");}
        public int slot(){return selected;}
        public boolean using(){return using;}
        public boolean mainHand(){return mainHand;}
        public JsonObject hand(){return hand.deepCopy();}
        public JsonArray inventory(){if(inventoryFault)throw error("UNSUPPORTED","Injected post-consumption receipt codec failure");JsonArray values=new JsonArray();values.add(hand());return values;}
        public int food(){return food;}
        public float saturation(){return saturation;}
        public void stopUsing(){stops++;using=false;stopCallback.run();}
    }
    private static final class Use {
        final View view=new View();final NativeActionBoundary boundary=new NativeActionBoundary();final AtomicLong time=new AtomicLong();
        final ControlSession.Operation operation=new ControlSession.Operation(UUID.randomUUID().toString(),"session",1,"eat-item",obj());
        final NativeFoodUse use;
        Use(){this(stack("minecraft:apple",3),null);}
        Use(JsonObject initial,JsonObject returned){view.hand=initial.deepCopy();use=new NativeFoodUse(operation,view,boundary,time::get,1000,2,initial,returned);view.stopCallback=()->{};boundary.sent();}
        void finish(JsonObject after){use.finished(true,2,view.hand(),after);view.hand=after.deepCopy();view.using=false;view.food=14;view.saturation=5;}
    }
    static void run(){
        // Mining hand: pickups filling an empty hand or growing the held stack are not a tool change
        check(SurvivalActions.sameHand(stack("minecraft:air",0),stack("minecraft:oak_log",1)),"An empty hand may pick up the log it is chopping");
        check(SurvivalActions.sameHand(stack("minecraft:oak_log",3),stack("minecraft:oak_log",5)),"The held stack growing from pickup is the same hand");
        check(!SurvivalActions.sameHand(stack("minecraft:iron_axe",1),stack("minecraft:stone_axe",1)),"Another tool in the slot is a hand change");
        JsonObject damaged=stack("minecraft:iron_axe",1);damaged.add("components",obj("minecraft:damage",3));
        check(!SurvivalActions.sameHand(stack("minecraft:iron_axe",1),damaged),"Changed tool components are a hand change");
        JsonObject observed=StackObservation.value("minecraft:apple",3,()->stack("minecraft:apple",3));
        check(observed.get("componentsComplete").getAsBoolean()&&observed.has("components"),"complete read preserves full component guard");
        for(RuntimeException failure:List.of(error("UNSUPPORTED","Transient component"),new IllegalStateException("Codec failed"))){
            JsonObject partial=StackObservation.value("example:unencodable",7,()->{throw failure;});
            check(!partial.get("componentsComplete").getAsBoolean()&&!partial.has("components"),"unknown components are omitted, never an invented empty object");
            check(partial.get("count").getAsInt()==7&&partial.get("id").getAsString().equals("example:unencodable")&&partial.has("componentError"),"read degradation keeps basic identity and explicit error");
        }
        Object inventory=new Object(),other=new Object();
        var slots=List.of(new MenuSlotSources.BackingSlot(other,0,9),new MenuSlotSources.BackingSlot(inventory,17,41),new MenuSlotSources.BackingSlot(inventory,2,41));
        check(InventorySwap.menuSlot(slots,inventory,17)==1&&InventorySwap.menuSlot(slots,inventory,2)==2,"source and hotbar map by native backing identity even at nonstandard offsets");
        errorCode("UNSUPPORTED",()->InventorySwap.menuSlot(slots,inventory,5));
        errorCode("UNSUPPORTED",()->InventorySwap.menuSlot(List.of(slots.get(1),slots.get(1)),inventory,17));
        JsonArray before=new JsonArray();for(int i=0;i<4;i++){JsonObject value=stack(i==3?"minecraft:apple":"minecraft:bread",i+1);value.addProperty("slot",i);before.add(value);}
        JsonArray after=before.deepCopy();JsonObject source=before.get(3).getAsJsonObject().deepCopy(),target=before.get(0).getAsJsonObject().deepCopy();source.addProperty("slot",0);target.addProperty("slot",3);after.set(0,source);after.set(3,target);
        check(InventorySwap.exact(before,after,3,0),"complete native swap conserves source, target, count and other inventory slots");
        after.get(1).getAsJsonObject().addProperty("count",99);check(!InventorySwap.exact(before,after,3,0),"unrelated native inventory mutation prevents an exact swap success");
        check(FoodSafety.reason(true,true,4,4.8f,32,false,false)==null,"ordinary effect-free verified food facts are admitted");
        check(FoodSafety.reason(true,false,4,4.8f,32,false,false)!=null,"special consume implementation facts are not auto-admitted");
        check(FoodSafety.reason(true,true,4,4.8f,32,true,false)!=null,"food with effects is not auto-admitted");
        check(FoodSafety.reason(true,true,4,4.8f,32,false,true)!=null,"protected food is not auto-admitted");
        check(FoodSafety.reason(false,true,4,2,32,false,false)!=null,"unknown Mod food implementation remains unsupported");
        check(FoodSafety.reason(true,true,4,Float.NaN,32,false,false)!=null,"non-finite food attributes are rejected");
        JsonObject metadata=FoodSafety.metadata(12,"minecraft:apple",3,4,4.8f,32,true,null);
        check(Math.abs(metadata.get("saturationModifier").getAsFloat()-0.6f)<0.0001f,"food metadata converts native saturation points to the actual modifier");
        for(JsonObject invalid:List.of(FoodSafety.metadata(12,"example:food",3,-1,1,32,true,null),FoodSafety.metadata(12,"example:food",3,4,Float.NaN,32,true,null),FoodSafety.metadata(12,"example:food",3,4,1,0,true,null)))
            check(!invalid.get("safe").getAsBoolean()&&invalid.get("metadataIncomplete").getAsBoolean()&&invalid.get("nutrition").getAsInt()==0&&invalid.get("eatDurationTicks").getAsInt()==0&&invalid.get("saturationModifier").getAsDouble()==0,"invalid native food metadata degrades to finite unsafe placeholders");
        Use normal=new Use();normal.use.tick();check(normal.operation.status.equals("running"),"native use remains running until an actual Finish event");
        normal.finish(stack("minecraft:apple",2));normal.use.tick();
        check(normal.operation.status.equals("succeeded")&&normal.operation.result.getAsJsonObject().get("consumedCount").getAsInt()==1&&normal.operation.result.getAsJsonObject().get("consumption").getAsString().equals("confirmed"),"bound native Finish plus final hand proves one consumed food");
        Use bowl=new Use(stack("minecraft:mushroom_stew",1),stack("minecraft:bowl",1));bowl.finish(stack("minecraft:bowl",1));bowl.use.tick();
        check(bowl.operation.status.equals("succeeded")&&bowl.operation.result.getAsJsonObject().getAsJsonObject("resultStack").get("id").getAsString().equals("minecraft:bowl"),"native return item is confirmed rather than miscounted as food remaining");
        Use empty=new Use(stack("minecraft:apple",1),null);empty.finish(stack("minecraft:air",0));empty.use.tick();check(empty.operation.status.equals("succeeded"),"last consumed food has an authoritative empty final hand");
        Use hungerOnly=new Use();hungerOnly.view.food=14;hungerOnly.view.using=false;hungerOnly.use.tick();
        check(hungerOnly.operation.status.equals("unknown")&&hungerOnly.operation.result.getAsJsonObject().get("code").getAsString().equals("FOOD_USE_UNKNOWN"),"hunger growth without a bound Finish cannot invent consumption");
        Use netOnly=new Use();netOnly.view.hand=stack("minecraft:apple",2);netOnly.view.using=false;netOnly.use.tick();check(netOnly.operation.status.equals("unknown")&&!netOnly.operation.result.getAsJsonObject().has("consumedCount"),"net item loss without native Finish does not confirm consumption");
        Use mismatched=new Use();mismatched.boundary.tick(mismatched.operation,()->mismatched.use.finished(false,2,mismatched.view.hand(),stack("minecraft:apple",2)),mismatched.use::stop);check(mismatched.operation.status.equals("unknown"),"offhand Finish cannot confirm mainhand food use");
        Use offhand=new Use();offhand.view.mainHand=false;offhand.use.tick();check(offhand.operation.status.equals("unknown")&&offhand.view.stops==1,"unexpected offhand use is stopped, never mistaken for a definite no-consumption refusal");
        Use wrongReturn=new Use(stack("minecraft:mushroom_stew",1),stack("minecraft:bowl",1));wrongReturn.finish(stack("minecraft:diamond",1));wrongReturn.use.tick();check(wrongReturn.operation.status.equals("unknown"),"unexpected final return cannot be called a successful safe consumption");
        Use codec=new Use();codec.finish(stack("minecraft:apple",2));codec.view.inventoryFault=true;codec.use.tick();
        check(codec.operation.status.equals("unknown")&&codec.operation.result.getAsJsonObject().get("lastConfirmedConsumedCount").getAsInt()==1&&codec.operation.result.getAsJsonObject().get("code").getAsString().equals("UNSUPPORTED"),"receipt codec failure preserves original error and already confirmed native consumption while result remains unknown");
        Use stopped=new Use();stopped.view.stopCallback=()->stopped.use.finished(true,2,stack("minecraft:apple",3),stack("minecraft:apple",2));stopped.use.stop();stopped.operation.finish("cancelled","Explicit stop",stopped.operation.result);stopped.use.tick();
        check(stopped.view.stops==1&&!stopped.use.alive()&&stopped.operation.status.equals("cancelled")&&!stopped.operation.json().has("result"),"stop clears use binding before reentrant or late Finish and never continues consumption");
        Use expired=new Use();expired.time.set(1000);expired.use.tick();check(expired.operation.status.equals("unknown")&&expired.view.stops==1,"timed-out native use is stopped without replay or an invented successful quantity");
        Use denied=new Use();denied.view.using=false;denied.use.tick();check(denied.operation.status.equals("failed")&&denied.operation.result.getAsJsonObject().get("consumedCount").getAsInt()==0,"native use refused with unchanged item and food is a confirmed zero-consumption failure");
        Use lost=new Use();lost.view.allowed=false;lost.use.tick();check(lost.operation.status.equals("unknown")&&lost.view.stops==1,"lost permission stops the in-flight native use");
        check(!ServerController.atomicAction("survival-state")&&!ServerController.atomicAction("assess-tool")&&ServerController.atomicAction("eat-item")&&ServerController.atomicAction("swap-inventory"),"readonly survival and assessment cannot be dispatched as mutation actions");
        System.out.println("SurvivalAlphaTest: "+checks+" checks passed (production guards, receipt tracker and fact selection; no Minecraft launch/native consumption execution)");
    }
}
