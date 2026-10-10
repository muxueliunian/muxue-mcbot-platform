package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.BooleanSupplier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * A standing order to protect one player, not tied to any operation: it outlives stops (a tool the follow steps aside
 * for, a reflex) and ends only when turned off, when control is revoked or released, or when the body changes. Each
 * tick it may take the body for a fight (the same {@link GuardCombat} a guarding follow uses) while what runs can be
 * interrupted and the body is within {@link #ENGAGE_RANGE} of the player; afterwards it hands the body back, and when
 * nothing else runs it walks back to the spot it left (docs/companion_state_design.md, section 5).
 */
final class GuardDuty {
    static final double ENGAGE_RANGE=16,BACK_REACH=1.2;
    static final long BACK_LIMIT_MS=15_000;
    interface View {
        long now();
        Vec3 position();
        /** The protected player's position: online, alive, same identity and dimension and within 32 blocks; otherwise null. */
        Vec3 companion();
        boolean mayDrive();
        /** One walking tick back to `spot`; true once there. Throws when there is no way. */
        boolean walkBack(Vec3 spot);
        void stopWalking();
    }
    /** What the duty needs from the fight: the {@link GuardCombat} methods, so tests can stand in for it. */
    interface Combat {
        boolean tick(Vec3 companion);
        void stop();
        JsonObject json();
    }
    final String player;
    final UUID uuid;
    final GuardCombat.Options options;
    private final View view;
    private final Combat combat;
    private boolean covering,fighting,driving,stopped;
    private long executionRevision;
    private String reason;
    private long fightStart,busyMs,backSince;
    private Vec3 anchor,back;

    GuardDuty(String player,UUID uuid,GuardCombat.Options options,View view,Combat combat) {
        this.player=player;this.uuid=uuid;this.options=options;this.view=view;this.combat=combat;
    }
    /**
     * interruptible: what runs now may be paused for a fight. idle: nothing else drives the body, so after a fight it
     * walks back to where it stood. Returns true when the duty drove the body this tick (the caller skips everything else).
     */
    boolean tick(boolean interruptible,boolean idle) {
        if(stopped)return false;
        long accepted=executionRevision;
        if(!view.mayDrive()){release();covering=false;reason="NO_CONTROL";return false;}
        Vec3 companion=view.companion();
        if(companion==null)return uncovered("PLAYER_AWAY");
        if(view.position().distanceTo(companion)>ENGAGE_RANGE)return uncovered("TOO_FAR");
        if(!interruptible)return uncovered("BUSY");
        covering=true;reason=null;
        Vec3 before=view.position();
        boolean drove=combat.tick(companion);
        if(stopped||accepted!=executionRevision)return false;
        long now=view.now();
        if(drove) {
            if(!fighting){fighting=true;fightStart=now;anchor=idle?before:null;back=null;}
            driving=true;return true;
        }
        if(fighting){fighting=false;busyMs+=now-fightStart;if(idle&&anchor!=null){back=anchor;backSince=now;}anchor=null;}
        if(back!=null) {
            if(!idle||now-backSince>BACK_LIMIT_MS){endBack();return false;}
            boolean there;
            try{there=view.position().distanceTo(back)<=BACK_REACH||view.walkBack(back);}
            catch(Protocol.Error noWay){there=true;}
            if(stopped||accepted!=executionRevision)return false;
            if(there){endBack();return false;}
            driving=true;return true;
        }
        driving=false;
        return false;
    }
    private boolean uncovered(String why) {
        release();covering=false;reason=why;return false;
    }
    /** Hand the body back now: an ongoing fight or walk back ends (its time still counts toward busyMs). */
    private void release() {
        if(fighting){fighting=false;busyMs+=view.now()-fightStart;combat.stop();}
        anchor=null;
        if(back!=null)endBack();
        driving=false;
    }
    private void endBack(){back=null;driving=false;view.stopWalking();}
    /** The body was stopped (any stop): drop the fight and the walk back, keep the duty. */
    void interrupt(){executionRevision++;boolean wasFighting=fighting;try{release();}finally{if(!wasFighting)combat.stop();}}
    /** Turned off or the lease ended. */
    void stop(){stopped=true;interrupt();}
    /** True while the duty is moving the body (fighting or walking back). */
    boolean driving(){return driving;}
    boolean fighting(){return fighting;}
    boolean protects(String name){return player.equals(name);}
    long busyMs(){return busyMs+(fighting?view.now()-fightStart:0);}
    JsonObject json() {
        JsonObject result=combat.json();
        result.addProperty("enabled",true);result.addProperty("player",player);result.addProperty("entityId",uuid.toString());
        result.addProperty("covering",covering);if(reason!=null)result.addProperty("reason",reason);
        result.addProperty("returning",back!=null);result.addProperty("busyMs",busyMs());
        return result;
    }

    static GuardDuty create(BodyPlayer body,BooleanSupplier mayDrive,MinecraftServer server,String player,UUID uuid,GuardCombat.Options options) {
        GuardCombat fight=GuardCombat.create(body,mayDrive,server,player,options);
        Combat combat=new Combat() {
            public boolean tick(Vec3 companion){return fight.tick(companion);}
            public void stop(){fight.stop();}
            public JsonObject json(){return fight.json();}
        };
        View view=new View() {
            NativeNavigation walk;
            public long now(){return System.nanoTime()/1_000_000;}
            public Vec3 position(){return body.position();}
            public Vec3 companion() {
                ServerPlayer target=server.getPlayerList().getPlayer(uuid);
                if(target==null||target==body||!target.isAlive()||target.isRemoved()||!target.getGameProfile().getName().equals(player)||target.serverLevel()!=body.serverLevel()||target.distanceToSqr(body)>32*32)return null;
                return target.position();
            }
            public boolean mayDrive(){return mayDrive.getAsBoolean();}
            public boolean walkBack(Vec3 spot) {
                if(walk==null)walk=new NativeNavigation(body,mayDrive).tolerateDamage();
                return walk.tick(spot,feet->feet.distanceTo(spot)<=BACK_REACH);
            }
            public void stopWalking(){if(walk!=null)walk.stop();walk=null;body.stopInput();}
        };
        return new GuardDuty(player,uuid,options,view,combat);
    }
    /** Parse a guard request: {off:true}, or {player, expectedEntityId, options?}. */
    static GuardCombat.Options options(JsonObject params) {
        GuardCombat.Options options=GuardCombat.Options.parse(params.has("options")?params.get("options"):new JsonObject());
        if(options==null)throw error("INVALID_ARGUMENT","guard options must be an object; use off:true to turn the guard off");
        return options;
    }
}
