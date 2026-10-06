package com.mcbot.servercontrol;

import net.minecraft.world.level.storage.LevelResource;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.ServerChatEvent;
import net.neoforged.neoforge.event.entity.player.ItemEntityPickupEvent;
import net.neoforged.neoforge.event.server.*;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.bus.api.EventPriority;
import java.io.IOException;

@Mod("mcbot_server_control")
public final class McbotServerControl {
    private static final org.slf4j.Logger LOGGER=com.mojang.logging.LogUtils.getLogger();
    private ServerController controller;
    private LocalHttpBridge bridge;
    private CommandFileFixture fixture;
    public McbotServerControl() {
        NeoForge.EVENT_BUS.addListener(this::started);
        NeoForge.EVENT_BUS.addListener(this::stopping);
        NeoForge.EVENT_BUS.addListener(this::beforeTick);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,this::chat);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,this::pickup);
        NeoForge.EVENT_BUS.addListener(EventPriority.HIGHEST,(ItemEntityPickupEvent.Pre event)->{if(controller!=null)controller.receivePickupPre(event,true);});
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,(ItemEntityPickupEvent.Pre event)->{if(controller!=null)controller.receivePickupPre(event,false);});
        NeoForge.EVENT_BUS.addListener(RespawnValidationFixture::register);
        NeoForge.EVENT_BUS.addListener(RespawnValidationFixture::cloneEvent);
        NeoForge.EVENT_BUS.addListener(RespawnValidationFixture::respawnEvent);
    }
    private void started(ServerStartedEvent event) {
        var directory=FMLPaths.CONFIGDIR.get().resolve("mcbot-server-control");
        try {
            var server=event.getServer();
            ServerConfig loaded=ServerConfig.load(directory,server.isDedicatedServer());
            ServerConfig config=loaded.withWorldId(HostingRules.worldId(loaded.worldId(),server.isDedicatedServer(),server.getWorldPath(LevelResource.ROOT)));
            // Add-on registration closes here; JSON interactions are read from config/mcbot-server-control/interactions.
            var adapters=ModAdapters.load(directory);
            for(String problem:adapters.problems()) LOGGER.warn("MCBOT adapter: {}",problem);
            LOGGER.info("MCBOT adapters: containers {}, interactions {}",adapters.containers().stream().map(a->a.id()).toList(),
                ItemInteractions.ids(ItemInteractions.installed()));
            controller=new ServerController(event.getServer(),config);
            bridge=new LocalHttpBridge(directory,config,event.getServer()::execute,controller::call);
            fixture=CommandFileFixture.start(server);
        } catch(IOException|RuntimeException e) {
            controller=null;
            throw new IllegalStateException("MCBOT local server control could not start (check server.json or port)",e);
        }
    }
    private void beforeTick(ServerTickEvent.Pre event) { if(controller!=null) controller.beforeServerTick(); }
    private void chat(ServerChatEvent event) { if(controller!=null) controller.receiveChat(event); }
    private void pickup(ItemEntityPickupEvent.Post event) {if(controller!=null)controller.receivePickup(event);}
    private void stopping(ServerStoppingEvent event) {
        if(fixture!=null) fixture.close(); fixture=null;
        if(bridge!=null) bridge.close(); bridge=null;
        if(controller!=null) controller.close(); controller=null;
    }
}
