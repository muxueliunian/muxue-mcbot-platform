package com.mcbot.servercontrol.mixin;

import com.mcbot.servercontrol.NativeRespawn;
import com.mojang.authlib.GameProfile;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/** Leaves the full vanilla respawn method intact, only preserving the BodyPlayer subtype. */
@Mixin(PlayerList.class)
abstract class PlayerListRespawnMixin {
    @Redirect(method="respawn",at=@At(value="NEW",target="net/minecraft/server/level/ServerPlayer"),require=1)
    private ServerPlayer mcbot$preserveBody(MinecraftServer server,ServerLevel level,GameProfile profile,
        ClientInformation information,ServerPlayer previous,boolean keepInventory,Entity.RemovalReason reason) {
        return NativeRespawn.replacement(server,level,profile,information,previous);
    }
}
