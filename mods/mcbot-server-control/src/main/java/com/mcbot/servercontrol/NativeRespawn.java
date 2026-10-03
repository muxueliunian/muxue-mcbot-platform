package com.mcbot.servercontrol;

import com.mojang.authlib.GameProfile;
import java.io.IOException;
import java.nio.file.Files;
import java.util.UUID;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.network.protocol.game.ServerboundClientCommandPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;
import static com.mcbot.servercontrol.Protocol.error;

/** Uses vanilla death respawn; the single constructor seam preserves our physical body type. */
public final class NativeRespawn {
    private NativeRespawn() { }

    /** Called only by PlayerListRespawnMixin at vanilla's new ServerPlayer expression. */
    public static ServerPlayer replacement(MinecraftServer server,ServerLevel level,GameProfile profile,
                                           ClientInformation information,ServerPlayer previous) {
        return previous instanceof BodyPlayer body
            ? body.createRespawnReplacement(server,level,profile,information)
            : new ServerPlayer(server,level,profile,information);
    }

    /** Explicit respawn may load a death save, but must never create a new living body. */
    static void requireDeadSave(MinecraftServer server,UUID uuid) {
        var file=server.getWorldPath(LevelResource.PLAYER_DATA_DIR).resolve(uuid+".dat");
        if(!Files.isRegularFile(file)) throw error("INVALID_ARGUMENT","No saved dead body to respawn");
        try {
            var saved=NbtIo.readCompressed(file,NbtAccounter.unlimitedHeap());
            if(!saved.contains("Health",99)||!Float.isFinite(saved.getFloat("Health"))||saved.getFloat("Health")>0)
                throw error("INVALID_ARGUMENT","Saved body is alive; respawn requires death");
        } catch(IOException failure) {
            throw error("WORLD_CHANGED","Cannot read the saved body for explicit respawn");
        }
    }

    static BodyPlayer perform(BodyPlayer previous) {
        if(previous==null||previous.getHealth()>0||previous.isAlive()) throw error("INVALID_ARGUMENT","Respawn requires a dead body");
        if(!(previous.connection instanceof VirtualGameListener listener)) throw error("WRONG_PLAYER","Body no longer has its virtual listener");
        if(previous.isRemoved()||!listener.getConnection().isConnected()) throw error("WORLD_CHANGED","Dead body connection was removed; reload its saved state explicitly");
        previous.stopInput();
        listener.clearPendingMotion();
        // Vanilla chooses bed/anchor/world spawn, restores inventory under gamerules,
        // fires clone/position/respawn events and applies hardcore spectator rules.
        listener.handleClientCommand(new ServerboundClientCommandPacket(ServerboundClientCommandPacket.Action.PERFORM_RESPAWN));
        if(!(listener.player instanceof BodyPlayer replacement)||replacement==previous)
            throw error("WORLD_CHANGED","Native respawn did not preserve the server body; inspect the Mixin binding");
        replacement.stopInput();
        listener.clearPendingMotion();
        replacement.pumpLocalTransport();
        return replacement;
    }
}
