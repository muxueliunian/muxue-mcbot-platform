package com.mcbot.spike;

import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.level.GameType;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.minecraft.world.entity.Entity;
import java.util.Set;
import java.util.UUID;

@Mod("mcbot_server_spike")
public final class McbotServerSpike {
    static final UUID ID = UUID.fromString("9c6882e0-e80c-4c3e-8f20-8e3f42c738a1");
    private SpikePlayer player;
    private VirtualConnection sink;

    public McbotServerSpike() {
        NeoForge.EVENT_BUS.addListener(this::registerCommands);
        NeoForge.EVENT_BUS.addListener(this::serverStopping);
        NeoForge.EVENT_BUS.addListener(this::afterServerTick);
    }

    private void registerCommands(RegisterCommandsEvent event) {
        event.getDispatcher().register(Commands.literal("mcbot-spike").requires(s -> s.hasPermission(2))
            .then(Commands.literal("spawn")
                .then(Commands.argument("x", DoubleArgumentType.doubleArg(-29_999_000, 29_999_000))
                .then(Commands.argument("y", DoubleArgumentType.doubleArg(-60, 1_000))
                .then(Commands.argument("z", DoubleArgumentType.doubleArg(-29_999_000, 29_999_000))
                    .executes(c -> spawn(c.getSource(), DoubleArgumentType.getDouble(c,"x"), DoubleArgumentType.getDouble(c,"y"), DoubleArgumentType.getDouble(c,"z")))))))
            .then(Commands.literal("status").executes(c -> status(c.getSource())))
            .then(Commands.literal("remove").executes(c -> { remove(c.getSource().getServer()); return status(c.getSource()); }))
            .then(Commands.literal("stop").executes(c -> { if (player != null) player.stopInput(); return status(c.getSource()); }))
            .then(Commands.literal("move")
                .then(Commands.argument("x", DoubleArgumentType.doubleArg(-1,1))
                .then(Commands.argument("z", DoubleArgumentType.doubleArg(-1,1))
                .then(Commands.argument("ticks", IntegerArgumentType.integer(1,100))
                    .executes(c -> move(c.getSource(), DoubleArgumentType.getDouble(c,"x"), DoubleArgumentType.getDouble(c,"z"), IntegerArgumentType.getInteger(c,"ticks"))))))));
    }

    private int spawn(CommandSourceStack source, double x, double y, double z) {
        MinecraftServer server = source.getServer();
        if (player != null || server.getPlayerList().getPlayer(ID) != null || server.getPlayerList().getPlayerByName("ServerBot") != null) {
            source.sendFailure(Component.literal("MCBOT_SPIKE_ALREADY_EXISTS"));
            return 0;
        }
        GameProfile profile = new GameProfile(ID, "ServerBot");
        if (server.getPlayerList().isOp(profile)) {
            source.sendFailure(Component.literal("MCBOT_SPIKE_REFUSES_OP_PROFILE"));
            return 0;
        }
        sink = new VirtualConnection();
        player = new SpikePlayer(server, server.overworld(), profile);
        CommonListenerCookie cookie = CommonListenerCookie.createInitial(profile, false);
        try {
            // Vanilla registration sends player info before entity spawn and supports late joiners.
            server.getPlayerList().placeNewPlayer(sink, player, cookie);
            player.connection = new VirtualGameListener(server, sink, player, cookie);
            sink.setVirtualListener(player.connection);
            player.setGameMode(GameType.SURVIVAL);
            // Explicit fixture setup only; movement commands never teleport.
            player.teleportTo(source.getLevel(), x, y, z, Set.of(), 0, 0);
            player.setInvulnerable(false);
            return status(source);
        } catch (RuntimeException failure) {
            remove(server);
            throw failure;
        }
    }

    private int move(CommandSourceStack source, double x, double z, int ticks) {
        if (player == null || !player.isAlive() || x*x+z*z < 0.0001) {
            source.sendFailure(Component.literal("MCBOT_SPIKE_NO_LIVE_BODY_OR_DIRECTION"));
            return 0;
        }
        player.moveInput(x,z,ticks);
        return status(source);
    }

    private int status(CommandSourceStack source) {
        MinecraftServer server = source.getServer();
        JsonObject json = new JsonObject();
        json.addProperty("exists", player != null && !player.isRemoved());
        json.addProperty("registered", server.getPlayerList().getPlayers().stream().filter(p -> p.getUUID().equals(ID)).count());
        json.addProperty("serverTick", server.getTickCount());
        if (player != null) {
            json.addProperty("uuid", ID.toString());
            json.addProperty("name", player.getGameProfile().getName());
            json.addProperty("entityId", player.getId());
            json.addProperty("x", player.getX()); json.addProperty("y", player.getY()); json.addProperty("z", player.getZ());
            json.addProperty("health", player.getHealth());
            json.addProperty("alive", player.isAlive());
            json.addProperty("food", player.getFoodData().getFoodLevel());
            json.addProperty("onGround", player.onGround());
            json.addProperty("horizontalCollision", player.horizontalCollision);
            json.addProperty("gameMode", player.gameMode.getGameModeForPlayer().getName());
            json.addProperty("op", server.getPlayerList().isOp(player.getGameProfile()));
            json.addProperty("worldTicks", player.worldTicks);
            json.addProperty("survivalTicks", player.survivalTicks);
            json.addProperty("duplicateSurvivalTicks", player.duplicateSurvivalTicks);
            json.addProperty("movingTicks", player.movingTicks);
            json.addProperty("controlActive", player.forwardInput != 0);
            json.addProperty("controlExpiresAt", player.controlExpiresAt);
            json.addProperty("discardedPackets", sink.discardedPackets);
            if (player.connection instanceof VirtualGameListener listener) {
                json.addProperty("ownMotionPacketsQueued", listener.ownMotionPacketsQueued);
                json.addProperty("ownMotionPacketsConsumed", listener.ownMotionPacketsConsumed);
                json.addProperty("ownMotionPending", listener.hasPendingMotion());
            }
        }
        source.sendSuccess(() -> Component.literal("MCBOT_SPIKE " + json), false);
        return 1;
    }

    private void remove(MinecraftServer server) {
        SpikePlayer oldPlayer = player;
        VirtualConnection oldSink = sink;
        player = null;
        sink = null;
        if (oldPlayer != null) {
            oldPlayer.stopInput();
            if (oldPlayer.connection instanceof VirtualGameListener listener) listener.clearPendingMotion();
            if (server.getPlayerList().getPlayer(ID) == oldPlayer) {
                oldPlayer.connection.onDisconnect(new DisconnectionDetails(Component.literal("MCBOT experiment removed")));
            } else if (!oldPlayer.isRemoved()) {
                oldPlayer.serverLevel().removePlayerImmediately(oldPlayer, Entity.RemovalReason.DISCARDED);
                oldPlayer.getTextFilter().leave();
            }
        }
        if (oldSink != null) oldSink.closeSink();
    }
    private void afterServerTick(ServerTickEvent.Post event) {
        // Only lifecycle reconciliation here; physical ticks belong exclusively to the entity.
        if (player != null && (player.isRemoved() || !sink.isConnected())) remove(event.getServer());
    }
    private void serverStopping(ServerStoppingEvent event) { remove(event.getServer()); }
}
