package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Only records native Post events; absence of an entity is never evidence of a pickup. */
final class PickupLedger {
    static final int LIMIT=256;
    private long cursor;
    private final ArrayDeque<JsonObject> receipts=new ArrayDeque<>();
    /** storedIn names the pickup sink (e.g. a carried backpack) that took the items instead of the inventory; null for the inventory. */
    JsonObject record(String entityId,JsonObject position,JsonObject original,JsonObject remaining,String session,long generation,String dimension,String storedIn) {
        int count=pickedUpCount(original,remaining);
        JsonObject stack=original.deepCopy();stack.addProperty("count",count);
        JsonObject receipt=obj("seq",++cursor,"entityId",entityId,"position",position,"stack",stack,"pickedUpCount",count,
            "sessionId",session,"controlGeneration",generation,"dimension",dimension);
        if(storedIn!=null)receipt.addProperty("storedIn",storedIn);
        receipts.addLast(receipt);while(receipts.size()>LIMIT)receipts.removeFirst();return receipt.deepCopy();
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
