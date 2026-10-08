package com.mcbot.addon.yessteve;

import com.mcbot.servercontrol.api.AppearanceSource;
import com.mcbot.servercontrol.api.McbotApi;
import java.util.List;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.fml.loading.FMLPaths;

/** The body's YSM model, picked by the hosting person from the server's {@code config/yes_steve_model/custom}. */
final class YsmModels implements AppearanceSource {
    static final YsmModels INSTANCE = new YsmModels();

    @Override public String id() { return "yes_steve_model:model"; }
    @Override public boolean installed() { return McbotApi.versionsMatch(YsmCommands.MOD, YsmCommands.VERSION); }
    @Override public List<String> choices(MinecraftServer server) {
        return YsmCommands.models(FMLPaths.CONFIGDIR.get().resolve("yes_steve_model").resolve("custom"));
    }
    @Override public void apply(ServerPlayer body, String choice) {
        Ysm.run(body.getServer(), YsmCommands.modelSet(body.getGameProfile().getName(), choice));
    }
}