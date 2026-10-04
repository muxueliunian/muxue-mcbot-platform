package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.List;
import static com.mcbot.servercontrol.Protocol.*;

/** Logical inventory indices are resolved by native backing identity, never fixed menu offsets. */
final class InventorySwap {
    static int menuSlot(List<MenuSlotSources.BackingSlot> slots,Object inventory,int logical) {
        int found=-1;
        for(int i=0;i<slots.size();i++) {
            var slot=slots.get(i);
            if(slot.container()==inventory&&slot.nativeIndex()==logical) {if(found>=0)throw error("UNSUPPORTED","Duplicate native inventory slot mapping");found=i;}
        }
        if(found<0)throw error("UNSUPPORTED","Native inventory slot mapping is unavailable");return found;
    }
    static boolean exact(JsonArray before,JsonArray after,int source,int target) {
        if(before.size()!=after.size())return false;
        for(int i=0;i<before.size();i++) {
            JsonObject expected=before.get(i==source?target:i==target?source:i).getAsJsonObject().deepCopy();
            expected.addProperty("slot",i);
            if(!expected.equals(after.get(i)))return false;
        }
        return true;
    }
}
