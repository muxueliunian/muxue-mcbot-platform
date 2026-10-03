package com.mcbot.control;

import com.mojang.logging.LogUtils;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.fml.loading.FMLPaths;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

@Mod(value="mcbot_control",dist=Dist.CLIENT)
public final class McbotControl {
    private static MinecraftController activeController;
    private final MinecraftController controller = new MinecraftController();
    private LocalHttpBridge bridge;
    public McbotControl(IEventBus modBus) {
        activeController=controller;
        modBus.addListener(this::setup);
        NeoForge.EVENT_BUS.addListener(controller::tick);
        NeoForge.EVENT_BUS.addListener(controller::chat);
        NeoForge.EVENT_BUS.addListener(controller::movementInput);
        NeoForge.EVENT_BUS.addListener(controller::manualKey);
        NeoForge.EVENT_BUS.addListener(controller::manualMouse);
    }
    public static boolean suppressVanillaAttack() {
        return activeController!=null&&activeController.controllingDig();
    }
    public static void serverBlock(ClientPacketListener connection,BlockPos position,BlockState state) {
        if(activeController!=null) activeController.serverBlock(connection,position,state);
    }
    private void setup(FMLClientSetupEvent event) {
        event.enqueueWork(()->{
            try {
                int port=Integer.getInteger("mcbot.control.port",8765);
                if(port<1024||port>65535) throw new IllegalArgumentException("Port must be 1024..65535");
                bridge=new LocalHttpBridge(FMLPaths.CONFIGDIR.get().resolve("mcbot-control"),port,
                        Minecraft.getInstance()::execute,controller::call);
                Runtime.getRuntime().addShutdownHook(new Thread(()->bridge.close(),"mcbot-control-shutdown"));
                LogUtils.getLogger().info("MCBOT control listening on 127.0.0.1:{}; credentials written to instance config",port);
            } catch(Exception e) {
                LogUtils.getLogger().error("MCBOT control failed to start: {}",e.getMessage());
            }
        });
    }
}
