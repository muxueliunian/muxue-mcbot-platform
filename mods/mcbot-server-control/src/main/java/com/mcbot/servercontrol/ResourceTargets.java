package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import java.util.function.LongSupplier;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import static com.mcbot.servercontrol.Protocol.*;

/** Bounded state-and-loaded-chunk references. Ordinary blocks have no entity-instance identity. */
final class ResourceTargets {
    static final long TTL_MS=120_000;
    static final int LIMIT=256;
    record Target(String session,long generation,Object dimension,BlockPos position,BlockState state,Object chunk,long expiresAt) {}
    private final ControlSession session;
    private final LongSupplier clock;
    private final LinkedHashMap<String,Target> targets=new LinkedHashMap<>();
    ResourceTargets(ControlSession session) {this(session,()->System.nanoTime()/1_000_000);}
    ResourceTargets(ControlSession session,LongSupplier clock) {this.session=session;this.clock=clock;}
    String issue(ServerPlayer body,BlockPos position,BlockState state) {
        var chunk=body.serverLevel().getChunkSource().getChunkNow(position.getX()>>4,position.getZ()>>4);
        if(chunk==null) throw error("UNLOADED","Resource chunk is not loaded");
        targets.entrySet().removeIf(e->e.getValue().expiresAt()<=clock.getAsLong());
        while(targets.size()>=LIMIT) targets.remove(targets.keySet().iterator().next());
        String id=UUID.randomUUID().toString();targets.put(id,new Target(session.sessionId(),session.generation(),body.serverLevel(),position.immutable(),state,chunk,clock.getAsLong()+TTL_MS));return id;
    }
    Target require(ServerPlayer body,String id) {
        Target target=targets.get(id);
        if(!valid(target,session.sessionId(),session.generation(),body.serverLevel(),clock.getAsLong())) throw error("STALE_TARGET","Resource reference expired or control changed");
        var chunk=body.serverLevel().getChunkSource().getChunkNow(target.position().getX()>>4,target.position().getZ()>>4);
        if(chunk!=target.chunk()||!chunk.getBlockState(target.position()).equals(target.state())) throw error("STALE_TARGET","Resource changed or its chunk reloaded");
        ResourceCatalog.requireSafe(body,target.position(),new FlatApproach(body));return target;
    }
    static boolean valid(Target target,String session,long generation,Object dimension,long now) {
        return target!=null&&Objects.equals(target.session(),session)&&target.generation()==generation&&target.dimension()==dimension&&now<target.expiresAt();
    }
}
