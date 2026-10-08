package com.mcbot.servercontrol;

/** The authority for one synchronous native attack call: which target it may damage, and its damage receipts. */
interface NativeAttackScope {
    boolean allowNativeTarget(String targetId);
    void refuseNative(RuntimeException failure);
    void receipt(String targetId,float amount);
}
