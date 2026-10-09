package com.mcbot.servercontrol;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.workstation.StationProgress;
import com.mcbot.servercontrol.api.workstation.Template;
import com.mcbot.servercontrol.api.workstation.WorkstationAdapter;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * machine-status (8b, read only): how far a machine the bot loaded earlier has got, read from the block without
 * walking there or opening it, for "load it, leave, come back when it is done". Only machines whose workstation
 * adapter implements {@link WorkstationAdapter#progress}, in the body's dimension, within {@link #RANGE} blocks and in
 * a loaded chunk (an unloaded machine does not work, so its time does not run either).
 */
final class MachineStatus {
    private MachineStatus() {}
    static final int RANGE=256;

    static JsonObject read(ServerPlayer player,JsonObject params) {
        BlockPos pos=new BlockPos((int)number(params,"x"),(int)number(params,"y"),(int)number(params,"z"));
        JsonObject result=obj("position",NativeWorkstation.pos(pos));
        var level=player.serverLevel();
        if(Math.hypot(pos.getX()+0.5-player.getX(),pos.getZ()+0.5-player.getZ())>RANGE) throw error("OUT_OF_REACH","Machine is more than "+RANGE+" blocks away");
        if(!level.hasChunkAt(pos)) { result.addProperty("state","unloaded");return result; }
        BlockState state=level.getBlockState(pos);
        result.addProperty("state","loaded");result.addProperty("id",BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
        StationProgress progress=null;String machine=null;
        for(Template template:Template.values()) {
            WorkstationAdapter adapter=ModAdapters.workstation(state,template);
            if(adapter==null)continue;
            try { progress=adapter.progress(level,pos,state);machine=adapter.id(); } catch(RuntimeException | LinkageError broken) { progress=null; }
            if(progress!=null)break;
        }
        result.addProperty("supported",progress!=null);
        if(progress==null) return result;
        result.addProperty("machine",machine);
        result.add("inputs",stacks(progress.inputs()));result.add("results",stacks(progress.results()));
        result.add("fuel",progress.fuel().isEmpty()?null:ItemDescriptions.describe(progress.fuel()));
        result.addProperty("working",progress.working());
        if(progress.ticksLeft()>=0){result.addProperty("ticksLeft",progress.ticksLeft());result.addProperty("secondsLeft",Math.round(progress.ticksLeft()/2.0)/10.0);}
        if(progress.fuelTicks()>=0)result.addProperty("fuelTicks",progress.fuelTicks());
        // Something left to do but not working: out of fuel, or the result slot is full.
        result.addProperty("stalled",!progress.inputs().isEmpty()&&!progress.working());
        return result;
    }
    private static JsonArray stacks(List<ItemStack> stacks){JsonArray array=new JsonArray();for(ItemStack s:stacks)array.add(ItemDescriptions.describe(s));return array;}
}
