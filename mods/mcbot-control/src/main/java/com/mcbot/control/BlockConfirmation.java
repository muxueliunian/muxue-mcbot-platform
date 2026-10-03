package com.mcbot.control;

import com.google.gson.JsonObject;

/** Evidence for one operation only. Local predictions and sequence acknowledgements never enter here. */
final class BlockConfirmation {
    private final String sessionId, expectedId;
    private final long target;
    private final boolean expectAir;
    private JsonObject latestServerState;
    private boolean matches;
    BlockConfirmation(String sessionId,long target,String expectedId,boolean expectAir) {
        this.sessionId=sessionId; this.target=target; this.expectedId=expectedId; this.expectAir=expectAir;
    }
    void serverBlock(String sessionId,long position,String id,boolean air,JsonObject serverState) {
        if(!this.sessionId.equals(sessionId)||target!=position) return;
        latestServerState=serverState.deepCopy();
        matches=expectAir?air:expectedId.equals(id);
    }
    boolean confirmed() { return latestServerState!=null&&matches; }
    JsonObject latestServerState() { return latestServerState==null?null:latestServerState.deepCopy(); }
}
