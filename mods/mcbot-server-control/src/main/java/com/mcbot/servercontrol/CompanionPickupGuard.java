package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.UUID;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** A short pickup detour remains tied to one live companion instance and its moving radius. */
final class CompanionPickupGuard {
    record Player(Object identity,UUID uuid,Object dimension,Vec3 position,boolean available) {}
    interface View {
        Object dimension();Vec3 bodyPosition();Vec3 itemPosition();Player companion(String name);
    }
    private final View view;
    private final String player;
    private final UUID expected;
    private final double maxDistance;
    private final Player bound;
    CompanionPickupGuard(JsonObject args,View view) {
        this.view=view;player=string(args,"player");
        if(!player.matches("[A-Za-z0-9_]{1,16}"))throw error("INVALID_ARGUMENT","companionGuard.player must be a player name");
        String uuid=string(args,"expectedEntityId");
        try {expected=UUID.fromString(uuid);if(!expected.toString().equalsIgnoreCase(uuid))throw new IllegalArgumentException();}
        catch(IllegalArgumentException invalid){throw error("INVALID_ARGUMENT","companionGuard.expectedEntityId must be a complete UUID");}
        number(args,"maxDistance");maxDistance=bounded(args,"maxDistance",0,1.5,4);
        bound=view.companion(player);
    }
    private Player current() {
        Player actual=view.companion(player);
        if(bound==null||actual==null||!actual.available()||actual.identity()!=bound.identity()||!expected.equals(actual.uuid())||
            actual.dimension()!=bound.dimension()||actual.dimension()!=view.dimension())
            throw error("STALE_COMPANION","Companion left, died, changed identity or dimension during pickup");
        return actual;
    }
    void validate() {
        Player actual=current();
        if(!within(view.bodyPosition(),actual.position())||!within(view.itemPosition(),actual.position()))
            throw error("COMPANION_OUT_OF_RANGE","Body or bound drop left the live companion pickup radius");
    }
    boolean allows(Vec3 point) {return within(point,current().position());}
    private boolean within(Vec3 point,Vec3 center){return point.distanceToSqr(center)<=maxDistance*maxDistance;}
}
