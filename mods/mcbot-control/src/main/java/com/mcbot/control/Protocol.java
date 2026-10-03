package com.mcbot.control;

import com.google.gson.*;

/** Version-neutral JSON validation; deliberately compares values rather than fingerprints. */
final class Protocol {
    // Nullable protocol fields are required on the wire, even when no world/menu exists.
    static final Gson JSON = new GsonBuilder().serializeNulls().create();
    static final class Error extends RuntimeException {
        final String code;
        Error(String code, String message) { super(message); this.code = code; }
    }
    static Error error(String code, String message) { return new Error(code, message); }
    static JsonObject obj(Object... pairs) {
        JsonObject o = new JsonObject();
        for (int i = 0; i < pairs.length; i += 2) o.add((String)pairs[i], JSON.toJsonTree(pairs[i + 1]));
        return o;
    }
    static JsonObject object(JsonObject o, String key) {
        if (!o.has(key) || !o.get(key).isJsonObject()) throw error("INVALID_ARGUMENT", key + " must be an object");
        return o.getAsJsonObject(key);
    }
    static String string(JsonObject o, String key) {
        if (!o.has(key) || !o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isString())
            throw error("INVALID_ARGUMENT", key + " must be a string");
        String s = o.get(key).getAsString();
        if (s.isBlank() || s.length() > 512) throw error("INVALID_ARGUMENT", key + " is empty or too long");
        return s;
    }
    static double number(JsonObject o, String key) {
        if (!o.has(key) || !o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isNumber())
            throw error("INVALID_ARGUMENT", key + " must be numeric");
        double n = o.get(key).getAsDouble();
        if (!Double.isFinite(n)) throw error("INVALID_ARGUMENT", key + " must be finite");
        return n;
    }
    static int integer(JsonObject o, String key) {
        double n = number(o, key);
        if (n != Math.rint(n) || n < Integer.MIN_VALUE || n > Integer.MAX_VALUE)
            throw error("INVALID_ARGUMENT", key + " must be an integer");
        return (int)n;
    }
    static double bounded(JsonObject o, String key, double fallback, double min, double max) {
        double n = o.has(key) ? number(o, key) : fallback;
        if (n < min || n > max) throw error("INVALID_ARGUMENT", key + " out of range");
        return n;
    }
    static void expectedStack(JsonObject args, String itemKey, String countKey, String actualId, int actualCount) {
        String expectedId=string(args,itemKey);
        int expectedCount=integer(args,countKey);
        if(expectedCount<0) throw error("INVALID_ARGUMENT",countKey+" must be non-negative");
        if(!expectedId.equals(actualId)||expectedCount!=actualCount)
            throw error("STALE_ITEM",itemKey+" / "+countKey+" no longer match the observed stack");
    }
}
