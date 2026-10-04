package com.mcbot.servercontrol;

import com.google.gson.*;

final class Protocol {
    static final Gson JSON = new GsonBuilder().serializeNulls().setPrettyPrinting().create();
    static final class Error extends RuntimeException {
        final String code;
        Error(String code, String message) { super(message); this.code = code; }
    }
    static Error error(String code, String message) { return new Error(code, message); }
    static JsonObject obj(Object... pairs) {
        JsonObject result = new JsonObject();
        for (int i=0; i<pairs.length; i+=2) result.add((String)pairs[i],JSON.toJsonTree(pairs[i+1]));
        return result;
    }
    static JsonObject object(JsonObject o,String key) {
        if (!o.has(key)||!o.get(key).isJsonObject()) throw error("INVALID_ARGUMENT",key+" must be an object");
        return o.getAsJsonObject(key);
    }
    static String string(JsonObject o,String key) {
        if (!o.has(key)||!o.get(key).isJsonPrimitive()||!o.getAsJsonPrimitive(key).isString()) throw error("INVALID_ARGUMENT",key+" must be a string");
        String value=o.get(key).getAsString();
        if(value.isBlank()||value.length()>512) throw error("INVALID_ARGUMENT",key+" empty or too long");
        return value;
    }
    static double number(JsonObject o,String key) {
        if(!o.has(key)||!o.get(key).isJsonPrimitive()||!o.getAsJsonPrimitive(key).isNumber()) throw error("INVALID_ARGUMENT",key+" must be numeric");
        double value=o.get(key).getAsDouble();
        if(!Double.isFinite(value)) throw error("INVALID_ARGUMENT",key+" must be finite");
        return value;
    }
    static boolean bool(JsonObject o,String key) {
        if(!o.has(key)||!o.get(key).isJsonPrimitive()||!o.getAsJsonPrimitive(key).isBoolean())throw error("INVALID_ARGUMENT",key+" must be boolean");
        return o.get(key).getAsBoolean();
    }
    static long generation(JsonObject o) {
        double value=number(o,"controlGeneration");
        if(value<0||value!=Math.rint(value)||value>9_007_199_254_740_991d) throw error("INVALID_ARGUMENT","Invalid controlGeneration");
        return (long)value;
    }
    static double bounded(JsonObject o,String key,double fallback,double min,double max) {
        double value=o.has(key)?number(o,key):fallback;
        if(value<min||value>max) throw error("INVALID_ARGUMENT",key+" out of range");
        return value;
    }
}
