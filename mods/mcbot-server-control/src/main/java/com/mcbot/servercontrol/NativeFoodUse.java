package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.function.LongSupplier;
import static com.mcbot.servercontrol.Protocol.*;

/** Tracks one native use and its native Finish event; hunger or net inventory deltas are never causal evidence. */
final class NativeFoodUse {
    interface View {
        void guard();int slot();boolean using();default boolean mainHand(){return true;}JsonObject hand();JsonArray inventory();int food();float saturation();void stopUsing();
    }
    final ControlSession.Operation operation;
    private final View view;
    private final NativeActionBoundary boundary;
    private final LongSupplier clock;
    private final long deadline;
    private final int slot,foodBefore;
    private final float saturationBefore;
    private final JsonObject initial,returnItem;
    private JsonObject nativeResult;
    private boolean alive=true;
    NativeFoodUse(ControlSession.Operation operation,View view,NativeActionBoundary boundary,LongSupplier clock,long deadline,int slot,JsonObject initial,JsonObject returnItem) {
        this.operation=operation;this.view=view;this.boundary=boundary;this.clock=clock;this.deadline=deadline;this.slot=slot;
        this.initial=initial.deepCopy();this.returnItem=returnItem==null?null:returnItem.deepCopy();foodBefore=view.food();saturationBefore=view.saturation();
    }
    boolean alive() {return alive;}
    void finished(boolean mainHand,int selectedSlot,JsonObject original,JsonObject result) {
        if(!alive||!operation.status.equals("running"))return;
        if(!mainHand||selectedSlot!=slot||!initial.equals(original)||nativeResult!=null) throw error("FOOD_USE_UNKNOWN","Native Finish event does not match this main-hand use");
        nativeResult=result.deepCopy();
    }
    void tick() {
        if(!alive)return;
        if(!operation.status.equals("running")) {stop();return;}
        boundary.tick(operation,()-> {
            view.guard();
            if(view.using()&&!view.mainHand())throw error("FOOD_USE_UNKNOWN","Native food use switched away from its authorized main hand");
            if(nativeResult!=null&&!view.using()) {
                verifyCompletion();
                operation.result=obj("lastConfirmedConsumedCount",1,"consumption","confirmed");
                JsonObject result=obj("consumedCount",1,"lastConfirmedConsumedCount",1,"consumption","confirmed","slot",slot,"resultStack",view.hand(),
                    "foodBefore",foodBefore,"foodAfter",view.food(),"saturationBefore",saturationBefore,"saturationAfter",view.saturation(),"inventory",view.inventory());
                boundary.confirmed();operation.finish("succeeded","Native main-hand Finish event and final item result confirmed",result);alive=false;return;
            }
            if(clock.getAsLong()>=deadline)throw error("TIMEOUT","Native food use deadline reached; no reliable consumption completion");
            if(view.slot()!=slot||!initial.equals(view.hand()))throw error("STALE_ITEM","Selected food changed during native use");
            if(!view.using()) {
                if(view.food()!=foodBefore||Float.compare(view.saturation(),saturationBefore)!=0)throw error("FOOD_USE_UNKNOWN","Use ended without a Finish receipt and authoritative food state changed");
                boundary.confirmed();operation.finish("failed","Native food use ended without consumption",obj("code","FORBIDDEN","consumedCount",0,"consumption","not-consumed"));alive=false;
            }
        },this::stop);
    }
    private void verifyCompletion() {
        if(view.slot()!=slot||!nativeResult.equals(view.hand())||!consumed(initial,nativeResult,returnItem))throw error("FOOD_USE_UNKNOWN","Native food Finish result or final selected stack changed; do not repeat use");
    }
    static boolean consumed(JsonObject before,JsonObject after,JsonObject returnItem) {
        if(before.get("count").getAsInt()==1) {
            if(after.get("count").getAsInt()==0&&after.get("id").getAsString().equals("minecraft:air"))return returnItem==null;
            if(returnItem!=null&&returnItem.equals(after))return true;
        }
        JsonObject remaining=before.deepCopy();remaining.addProperty("count",before.get("count").getAsInt()-1);
        return remaining.get("count").getAsInt()>0&&remaining.equals(after);
    }
    void stop() {
        if(!alive)return;
        alive=false; // Clear the association before native Stop/Mod callbacks can deliver another Finish.
        if(nativeResult!=null&&!view.using()) {
            try {
                verifyCompletion();JsonObject result=operation.result!=null&&operation.result.isJsonObject()?operation.result.getAsJsonObject():obj();
                result.addProperty("lastConfirmedConsumedCount",1);result.addProperty("consumption","confirmed");operation.result=result;
            }
            catch(RuntimeException ignored) { /* A stopped use must not invent a consumption receipt. */ }
        }
        view.stopUsing();
    }
}
