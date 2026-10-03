package com.mcbot.control;

import static com.mcbot.control.Protocol.*;

/** Screen decisions are independent of native focus and never dismiss a user's UI. */
final class ControlPolicy {
    static void worldAction(boolean paused, boolean hasScreen, boolean pauseScreen, boolean containerOpen) {
        if(paused) throw error("WORLD_PAUSED","Resume the paused single-player world before control");
        if(containerOpen||(hasScreen&&!pauseScreen))
            throw error("SCREEN_OPEN","Close the current gameplay screen before this action");
    }
}
