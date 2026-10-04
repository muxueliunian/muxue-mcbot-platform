package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.function.Supplier;
import static com.mcbot.servercontrol.Protocol.*;

/** Read-only degradation; strict native action guards continue using complete stackValue(). */
final class StackObservation {
    static JsonObject value(String id,int count,Supplier<JsonObject> complete) {
        try { JsonObject result=complete.get();result.addProperty("componentsComplete",true);return result; }
        catch(RuntimeException failure) {
            return obj("id",id,"count",count,"componentsComplete",false,"componentError",failure instanceof Protocol.Error error?error.code:"COMPONENT_ENCODING_FAILED");
        }
    }
}
