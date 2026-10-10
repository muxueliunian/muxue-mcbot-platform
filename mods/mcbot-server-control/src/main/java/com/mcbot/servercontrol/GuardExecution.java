package com.mcbot.servercontrol;

import java.util.function.BooleanSupplier;

/** Revocable execution within a standing intent: old native callbacks never inherit a later tick's authority. */
final class GuardExecution {
    private final BooleanSupplier live;
    private long revision;
    GuardExecution(BooleanSupplier live){this.live=live;}
    BooleanSupplier capture(){long accepted=revision;return ()->accepted==revision&&live.getAsBoolean();}
    void interrupt(){revision++;}
}
