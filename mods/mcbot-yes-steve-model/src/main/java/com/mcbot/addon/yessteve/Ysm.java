package com.mcbot.addon.yessteve;

import com.mcbot.servercontrol.api.McbotApi;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;

/** Runs a YSM command as the server console, silently. YSM answers nothing either way, so success cannot be read back. */
final class Ysm {
    private Ysm() {}

    static void run(MinecraftServer server, String command) {
        if (server == null) throw McbotApi.refuse("UNSUPPORTED", "The body is not on a server");
        CommandSourceStack console = server.createCommandSourceStack().withSuppressedOutput().withPermission(4);
        server.getCommands().performPrefixedCommand(console, command);
    }
}