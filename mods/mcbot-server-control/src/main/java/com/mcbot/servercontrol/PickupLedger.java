package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Only records native Post events; absence of an entity is never evidence of a pickup. */
final class PickupLedger {
    static final int LIMIT=256;
    private long cursor;
    private final ArrayDeque<JsonObject> receipts=new ArrayDeque<>();
    /** A receipt without a thrower. */
    JsonObject record(String entityId,JsonObject position,JsonObject original,JsonObject remaining,String session,long generation,String dimension,String storedIn) {
        return record(entityId,position,original,remaining,session,generation,dimension,storedIn,null);
    }
    /**
     * storedIn names the pickup sink (e.g. a carried backpack) that took the items instead of the inventory; null for the inventory.
     * thrownBy is the player who threw the item ({@link #thrownBy}), null when nobody did (mined, mob loot) or the body did.
     */
    JsonObject record(String entityId,JsonObject position,JsonObject original,JsonObject remaining,String session,long generation,String dimension,String storedIn,String thrownBy) {
        int count=pickedUpCount(original,remaining);
        JsonObject stack=original.deepCopy();stack.addProperty("count",count);
        JsonObject receipt=obj("seq",++cursor,"entityId",entityId,"position",position,"stack",stack,"pickedUpCount",count,
            "sessionId",session,"controlGeneration",generation,"dimension",dimension);
        if(storedIn!=null)receipt.addProperty("storedIn",storedIn);
        if(thrownBy!=null)receipt.addProperty("thrownBy",thrownBy);
        receipts.addLast(receipt);while(receipts.size()>LIMIT)receipts.removeFirst();return receipt.deepCopy();
    }
    /**
     * The name of the player who threw a picked-up item (gift-receipts): the item's thrower is a player other than the
     * body. Block drops and mob loot have no thrower; what the body itself dropped (drop-item, a give that was not
     * taken) has the body as thrower and is no gift.
     */
    static String thrownBy(UUID thrower,String throwerName,boolean throwerIsPlayer,UUID body) {
        if(thrower==null||!throwerIsPlayer||thrower.equals(body)||throwerName==null||throwerName.isEmpty())return null;
        return throwerName;
    }
    static int pickedUpCount(JsonObject original,JsonObject remaining) {
        int before=SurvivalActions.integer(original,"count"),after=SurvivalActions.integer(remaining,"count");
        if(before<=0||after<0||after>=before||!original.has("maxStackSize")) throw error("PICKUP_UNKNOWN","Native pickup event has no positive attributable count");
        if(after>0&&(!Objects.equals(original.get("id"),remaining.get("id"))||!Objects.equals(original.get("components"),remaining.get("components"))||!Objects.equals(original.get("maxStackSize"),remaining.get("maxStackSize"))))
            throw error("PICKUP_UNKNOWN","Native remaining stack changed variant or effective maximum");
        return before-after;
    }
    void unknown() {cursor++;receipts.clear();}
    JsonObject observation() {
        long oldest=receipts.isEmpty()?cursor:receipts.getFirst().get("seq").getAsLong()-1;
        return obj("pickupCursor",cursor,"pickupOldestCursor",oldest,"pickupReceipts",receipts);
    }
}
