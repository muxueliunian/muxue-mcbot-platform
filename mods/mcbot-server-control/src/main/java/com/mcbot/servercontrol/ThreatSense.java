package com.mcbot.servercontrol;

import com.google.gson.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.*;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.player.Player;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Read-only native facts. A Monster superclass alone does not make a neutral mob an attack target. */
final class ThreatSense {
    private static final Set<String> HOSTILE=Set.of("zombie","husk","drowned","zombie_villager","skeleton","stray","bogged","wither_skeleton","creeper","slime","magma_cube","silverfish","endermite","witch","pillager","vindicator","evoker","vex","ravager","phantom","blaze","ghast","guardian","elder_guardian","shulker");
    record Verdict(String classification,String source,boolean targetingSelf,boolean eligible,String reason) {}
    static LivingEntity lookup(ServerPlayer player,String entityId,String dimension) {
        if(!player.serverLevel().dimension().location().toString().equals(dimension))throw error("WORLD_CHANGED","Threat dimension changed");
        UUID uuid;try{uuid=UUID.fromString(entityId);}catch(IllegalArgumentException failure){throw error("INVALID_ARGUMENT","entityId must be a UUID");}
        Entity entity=player.serverLevel().getEntity(uuid);
        if(!(entity instanceof LivingEntity living)||entity==player||entity.isRemoved())throw error("STALE_TARGET","Threat identity no longer exists in this dimension");
        return living;
    }
    static Verdict assess(ServerPlayer player,LivingEntity target) {
        boolean targeting=target instanceof Mob mob&&mob.getTarget()==player;
        boolean recent=player.getLastHurtByMob()==target&&player.tickCount-player.getLastHurtByMobTimestamp()>=0&&player.tickCount-player.getLastHurtByMobTimestamp()<=100;
        var key=BuiltInRegistries.ENTITY_TYPE.getKey(target.getType());
        boolean vanilla=key.getNamespace().equals("minecraft")&&target.getClass().getName().startsWith("net.minecraft.");
        boolean hostile=vanilla&&HOSTILE.contains(key.getPath());
        return classify(target instanceof Player,player.isAlliedTo(target)||target.isAlliedTo(player)||(target instanceof TamableAnimal tame&&player.getUUID().equals(tame.getOwnerUUID())),hostile,targeting,recent,vanilla);
    }
    static Verdict classify(boolean player,boolean allied,boolean hostile,boolean targeting,boolean recent,boolean vanilla) {
        if(player)return new Verdict("player","none",targeting,false,"PLAYER_EXCLUDED");
        if(allied)return new Verdict("friendly","none",targeting,false,"FRIENDLY_EXCLUDED");
        if(targeting||recent)return new Verdict("attacking_self",targeting?"native_target_self":"native_recent_attacker",targeting,true,null);
        if(hostile)return new Verdict("hostile","vanilla_hostile_allowlist",false,true,null);
        return new Verdict(vanilla?"neutral":"unknown",vanilla?"none":"unknown",false,false,vanilla?"NOT_ATTACKING_SELF":"UNVERIFIED_HOSTILITY");
    }
    static void requireEligible(ServerPlayer player,LivingEntity target) {
        Verdict verdict=assess(player,target);if(!verdict.eligible())throw error("FORBIDDEN",verdict.reason());
    }
    static boolean explosionPreparing(LivingEntity target) {return target instanceof Creeper creeper&&(creeper.isIgnited()||creeper.getSwellDir()>0);}
    static boolean retreatRequired(ServerPlayer player,LivingEntity target,double minHealth) {return player.getHealth()<=minHealth||explosionPreparing(target);}
    static JsonObject dangers(ServerPlayer player) {
        return obj("onFire",player.isOnFire(),"inLava",player.isInLava(),"inWater",player.isInWater(),"air",player.getAirSupply(),"maxAir",player.getMaxAirSupply(),"fallDistance",player.fallDistance,"lowHealth",player.getHealth()<=8,"retreatRecommended",player.getHealth()<=8);
    }
    static JsonObject nearby(ServerPlayer player) {
        List<LivingEntity> candidates;
        try {candidates=player.serverLevel().getEntitiesOfClass(LivingEntity.class,player.getBoundingBox().inflate(8),e->e!=player);}
        catch(RuntimeException failure){return obj("radius",8,"complete",false,"nearby",new JsonArray(),"serverTick",player.getServer().getTickCount(),"reason","NATIVE_THREAT_SCAN_UNAVAILABLE");}
        JsonArray nearby=new JsonArray();List<JsonObject> facts=new ArrayList<>();boolean complete=true;
        int minX=BlockPos.containing(player.getX()-8,player.getY(),player.getZ()-8).getX()>>4,maxX=BlockPos.containing(player.getX()+8,player.getY(),player.getZ()+8).getX()>>4;
        int minZ=BlockPos.containing(player.getX()-8,player.getY(),player.getZ()-8).getZ()>>4,maxZ=BlockPos.containing(player.getX()+8,player.getY(),player.getZ()+8).getZ()>>4;
        for(int x=minX;x<=maxX;x++)for(int z=minZ;z<=maxZ;z++)if(!player.serverLevel().hasChunkAt(new BlockPos(x<<4,player.getBlockY(),z<<4)))complete=false;
        for(LivingEntity entity:candidates) {
            String identity=null;
            try {
                identity=entity.getUUID().toString();double distance=entity.distanceToSqr(player);
                if(!Double.isFinite(distance)||distance<0)throw error("NATIVE_FACTS_UNAVAILABLE","Native entity distance is not finite");
                if(distance>64||!entity.isAlive())continue;
                Verdict v=assess(player,entity);facts.add(obj("entityId",identity,"type",BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString(),"classification",v.classification(),"hostilitySource",v.source(),"targetingSelf",v.targetingSelf(),"distance",Math.sqrt(distance),"lineOfSight",player.hasLineOfSight(entity),"alive",true,"explosionPreparing",explosionPreparing(entity),"defenseEligible",v.eligible(),"defenseReason",v.reason(),"factsAvailable",true));
            } catch(RuntimeException failure) {complete=false;if(identity!=null)facts.add(unavailable(identity));}
        }
        facts.sort(Comparator.comparingDouble(value->value.get("distance").isJsonNull()?Double.POSITIVE_INFINITY:value.get("distance").getAsDouble()));
        if(facts.size()>24)complete=false;for(JsonObject fact:facts.subList(0,Math.min(24,facts.size())))nearby.add(fact);
        return obj("radius",8,"complete",complete,"nearby",nearby,"serverTick",player.getServer().getTickCount());
    }
    static JsonObject unavailable(String identity) {
        return obj("entityId",identity,"type",null,"classification","unknown","hostilitySource","unknown","targetingSelf",null,"distance",null,"lineOfSight",null,"alive",null,"explosionPreparing",null,"defenseEligible",false,"defenseReason","NATIVE_FACTS_UNAVAILABLE","factsAvailable",false);
    }
}
