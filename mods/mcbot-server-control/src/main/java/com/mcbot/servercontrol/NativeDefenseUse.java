package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.function.LongSupplier;
import static com.mcbot.servercontrol.Protocol.*;

/** One finite stationary action; native post-damage receipts are scoped to the synchronous attack call. */
final class NativeDefenseUse {
    interface View {void guard();String termination();boolean cooledDown();void attack();boolean targetAlive();}
    final ControlSession.Operation operation;
    private final View view;
    private final NativeActionBoundary boundary;
    private final LongSupplier clock;
    private final long deadline;
    private final int maximum;
    private final String entityId;
    private boolean alive=true,attacking,collateral,uncertain,nativeCall;
    private RuntimeException nativeRefusal;
    private int attempts,hits;
    private double damage,attackDamage;
    NativeDefenseUse(ControlSession.Operation operation,View view,NativeActionBoundary boundary,LongSupplier clock,long deadline,int maximum,String entityId) {
        this.operation=operation;this.view=view;this.boundary=boundary;this.clock=clock;this.deadline=deadline;this.maximum=maximum;this.entityId=entityId;
    }
    boolean alive(){return alive;}
    boolean nativeWriteInProgress(){return nativeCall;}
    boolean allowNativeTarget(String targetId) {
        if(!nativeCall)return false;
        if(!operation.status.equals("running")||!entityId.equals(targetId)){refuseNative(error("LEASE_LOST","Native defense scope or target is no longer authorized"));return false;}
        try {view.guard();if(view.termination()!=null){refuseNative(error("STALE_TARGET","Native threat changed before damage"));return false;}return true;}
        catch(RuntimeException failure){refuseNative(failure);return false;}
    }
    void refuseNative(RuntimeException failure){if(nativeRefusal==null)nativeRefusal=failure;}
    void requireNativeAuthorized(){if(nativeRefusal!=null)throw nativeRefusal;if(!operation.status.equals("running"))throw error("LEASE_LOST","Native operation was cancelled inside its call");}
    void receipt(String targetId,float amount) {
        // A prior Post listener may stop intent after damage was applied. Preserve this same-call read-only receipt.
        if(!nativeCall)return;
        if(!entityId.equals(targetId)||!Float.isFinite(amount)||amount<0){collateral=true;return;}
        attackDamage+=amount;
    }
    void tick() {
        if(!alive)return;
        if(!operation.status.equals("running")){stop();return;}
        boundary.tick(operation,()-> {
            view.guard();String termination=view.termination();
            if(termination!=null){finish(termination);return;}
            if(clock.getAsLong()>=deadline){finish("timeout");return;}
            if(attempts>=maximum){finish("attack_limit");return;}
            if(!view.cooledDown())return;
            view.guard();boundary.sent();uncertain=true;attempts++;attackDamage=0;collateral=false;attacking=true;nativeCall=true;nativeRefusal=null;
            try {view.attack();requireNativeAuthorized();}
            finally {nativeCall=false;attacking=false;if(attackDamage>0){hits++;damage+=attackDamage;}record(alive?"running":"stopped");}
            if(collateral)throw error("DEFENSE_EFFECT_UNKNOWN","Native attack had unexpected damage receipts");
            uncertain=false;boundary.confirmed();record("running");
            if(!view.targetAlive())finish("target_dead");else if(attempts>=maximum)finish("attack_limit");
        },this::stop);
    }
    private void finish(String reason) {record(reason);operation.finish("succeeded","Finite native defense ended: "+reason,operation.result);alive=false;}
    private void record(String reason) {
        JsonObject result=operation.result!=null&&operation.result.isJsonObject()?operation.result.getAsJsonObject():obj();
        result.addProperty("entityId",entityId);result.addProperty("attemptedAttacks",attempts);result.addProperty("confirmedHits",hits);result.addProperty("confirmedDamage",damage);result.addProperty("damageConfirmation","native_damage_event");
        result.addProperty("terminationReason",reason);result.addProperty("targetAlive",view.targetAlive());result.addProperty("sideEffects",uncertain||operation.status.equals("unknown")?"unknown":attempts>0?"confirmed":"none");operation.result=result;
    }
    void stop(){if(!alive)return;alive=false;attacking=false;record(operation.status.equals("unknown")?"unknown":"stopped");}
}
