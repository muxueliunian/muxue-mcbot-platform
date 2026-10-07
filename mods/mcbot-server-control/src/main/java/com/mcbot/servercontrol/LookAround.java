package com.mcbot.servercontrol;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Read-only summary of the loaded surroundings: who and what is around, and notable blocks a player
 * could see. A block only counts when one of its faces is open (air, fluid or a see-through block), so
 * buried ores and chests inside solid rock stay hidden; the nearest of each kind is also checked for
 * line of sight. Never loads chunks, moves the body or issues interaction tokens.
 */
final class LookAround {
    static final int MAX_RADIUS=32,MIN_RADIUS=8,BELOW=8,ABOVE=8,MAX_GROUPS=24,MAX_CREATURES=16,MAX_ITEMS=12,MAX_PLAYERS=8;
    private LookAround() {}

    static int radius(JsonObject params) {
        double value=bounded(params,"radius",MAX_RADIUS,MIN_RADIUS,MAX_RADIUS);
        if(value!=Math.rint(value))throw error("INVALID_ARGUMENT","radius must be an integer");
        return (int)value;
    }
    /** The kind of notable block, or null for ordinary terrain. */
    static String category(BlockState state) {
        Block block=state.getBlock();
        if(state.is(ResourceCatalog.ORES))return "ore";
        if(state.is(BlockTags.LOGS))return "log";
        if(NearbyBlocks.ordinaryContainer(state))return "container";
        if(state.is(BlockTags.BEDS))return "bed";
        if(block==Blocks.SPAWNER||block==Blocks.TRIAL_SPAWNER||block==Blocks.VAULT)return "spawner";
        if(block==Blocks.NETHER_PORTAL||block==Blocks.END_PORTAL_FRAME)return "portal";
        if(block==Blocks.CRAFTING_TABLE||block==Blocks.ENCHANTING_TABLE||block==Blocks.SMITHING_TABLE||block==Blocks.STONECUTTER||block==Blocks.GRINDSTONE||
            block==Blocks.LOOM||block==Blocks.CARTOGRAPHY_TABLE||block==Blocks.FLETCHING_TABLE||block==Blocks.BREWING_STAND||state.is(BlockTags.ANVIL)||block==Blocks.COMPOSTER)return "workstation";
        if(state.is(BlockTags.DOORS))return "door";
        if(state.is(BlockTags.CROPS))return "crop";
        if(state.getFluidState().isSource()&&state.getFluidState().is(Fluids.LAVA))return "lava";
        if(state.getFluidState().isSource()&&state.getFluidState().is(Fluids.WATER))return "water";
        return null;
    }
    private static final List<String> ORDER=List.of("lava","spawner","ore","container","bed","workstation","portal","door","log","crop","water");
    /** Eight-way compass word for a horizontal offset (north is -z). */
    static String direction(double dx,double dz) {
        if(dx*dx+dz*dz<0.25)return "here";
        double degrees=Math.toDegrees(Math.atan2(dx,-dz));
        String[] names={"north","north-east","east","south-east","south","south-west","west","north-west"};
        return names[Math.floorMod((int)Math.round(degrees/45),8)];
    }
    static String phase(long dayTime) {
        long t=Math.floorMod(dayTime,24000L);
        return t<12000?"day":t<13800?"dusk":t<22200?"night":"dawn";
    }

    private static final class Group {
        final String id,category;int count;double nearest=Double.MAX_VALUE;BlockPos at;
        Group(String id,String category){this.id=id;this.category=category;}
    }
    private static BlockState loaded(ServerLevel level,BlockPos pos) {
        if(level.isOutsideBuildHeight(pos))return null;
        var chunk=level.getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
        return chunk==null?null:chunk.getBlockState(pos);
    }
    private static boolean exposed(ServerLevel level,BlockPos pos) {
        for(Direction direction:Direction.values()) {
            BlockPos next=pos.relative(direction);BlockState neighbour=loaded(level,next);
            if(neighbour!=null&&(neighbour.isAir()||!neighbour.getFluidState().isEmpty()||!neighbour.isSolidRender(level,next)))return true;
        }
        return false;
    }
    private static JsonObject where(ServerPlayer body,Vec3 target) {
        Vec3 feet=body.position();double dx=target.x-feet.x,dz=target.z-feet.z;
        return obj("distance",Math.round(target.distanceTo(feet)*10)/10.0,"direction",direction(dx,dz),"dy",Math.round((target.y-feet.y)*10)/10.0,
            "position",obj("x",Math.round(target.x*10)/10.0,"y",Math.round(target.y*10)/10.0,"z",Math.round(target.z*10)/10.0));
    }
    private static boolean sees(ServerPlayer body,BlockPos target) {
        Vec3 eye=body.getEyePosition(),centre=Vec3.atCenterOf(target);
        BlockHitResult hit=body.level().clip(new ClipContext(eye,centre,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,body));
        return hit.getType()==HitResult.Type.MISS||hit.getBlockPos().equals(target);
    }

    static JsonObject summarize(ServerPlayer body,JsonObject params) {
        int radius=radius(params);
        ServerLevel level=body.serverLevel();BlockPos origin=body.blockPosition();Vec3 feet=body.position();
        Map<String,Group> groups=new HashMap<>();int columns=0,unloaded=0;
        BlockPos.MutableBlockPos pos=new BlockPos.MutableBlockPos();
        for(int x=-radius;x<=radius;x++) for(int z=-radius;z<=radius;z++) {
            if(x*x+z*z>radius*radius)continue;
            columns++;
            if(level.getChunkSource().getChunkNow((origin.getX()+x)>>4,(origin.getZ()+z)>>4)==null){unloaded++;continue;}
            for(int y=-BELOW;y<=ABOVE;y++) {
                pos.set(origin.getX()+x,origin.getY()+y,origin.getZ()+z);
                BlockState state=loaded(level,pos);
                if(state==null||state.isAir())continue;
                String category=category(state);
                if(category==null)continue;
                if(category.equals("water")||category.equals("lava")){BlockState above=loaded(level,pos.above());if(above==null||!above.isAir())continue;}
                else if(!exposed(level,pos))continue;
                String id=BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
                Group group=groups.computeIfAbsent(category.equals("bed")?"minecraft:bed":id,key->new Group(key,category));
                group.count++;
                double distance=Vec3.atCenterOf(pos).distanceTo(feet);
                if(distance<group.nearest){group.nearest=distance;group.at=pos.immutable();}
            }
        }
        List<Group> notable=new ArrayList<>(groups.values());
        notable.sort(Comparator.comparingInt((Group g)->ORDER.indexOf(g.category)).thenComparingDouble(g->g.nearest).thenComparing(g->g.id));
        JsonArray blocks=new JsonArray();
        for(Group group:notable.subList(0,Math.min(notable.size(),MAX_GROUPS))) {
            JsonObject nearest=where(body,Vec3.atBottomCenterOf(group.at));nearest.addProperty("visible",sees(body,group.at));
            blocks.add(obj("id",group.id,"category",group.category,"count",group.count,"nearest",nearest));
        }

        JsonArray players=new JsonArray(),creatures=new JsonArray(),items=new JsonArray();
        Map<String,List<Entity>> living=new HashMap<>(),dropped=new HashMap<>();Map<String,Integer> stacked=new HashMap<>();
        List<Player> people=new ArrayList<>();
        for(Entity entity:level.getEntities(body,body.getBoundingBox().inflate(radius))) {
            if(!entity.isAlive()||entity.distanceTo(body)>radius)continue;
            if(entity instanceof Player player){if(!player.isSpectator())people.add(player);}
            else if(entity instanceof ItemEntity item&&!item.getItem().isEmpty()){
                String id=BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString();
                dropped.computeIfAbsent(id,key->new ArrayList<>()).add(item);stacked.merge(id,item.getItem().getCount(),Integer::sum);
            }
            else if(entity instanceof LivingEntity)living.computeIfAbsent(BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString(),key->new ArrayList<>()).add(entity);
        }
        people.sort(Comparator.comparingDouble(p->p.distanceTo(body)));
        for(Player person:people.subList(0,Math.min(people.size(),MAX_PLAYERS))) {
            JsonObject at=where(body,person.position());at.addProperty("name",person.getGameProfile().getName());at.addProperty("visible",body.hasLineOfSight(person));
            players.add(at);
        }
        List<Map.Entry<String,List<Entity>>> kinds=new ArrayList<>(living.entrySet());
        for(var kind:kinds)kind.getValue().sort(Comparator.comparingDouble(e->e.distanceTo(body)));
        kinds.sort(Comparator.comparing((Map.Entry<String,List<Entity>> k)->!(k.getValue().getFirst() instanceof Enemy)).thenComparingDouble(k->k.getValue().getFirst().distanceTo(body)));
        for(var kind:kinds.subList(0,Math.min(kinds.size(),MAX_CREATURES))) {
            Entity first=kind.getValue().getFirst();JsonObject nearest=where(body,first.position());nearest.addProperty("visible",body.hasLineOfSight(first));
            creatures.add(obj("type",kind.getKey(),"count",kind.getValue().size(),"hostile",first instanceof Enemy,"nearest",nearest));
        }
        List<Map.Entry<String,List<Entity>>> stacks=new ArrayList<>(dropped.entrySet());
        for(var stack:stacks)stack.getValue().sort(Comparator.comparingDouble(e->e.distanceTo(body)));
        stacks.sort(Comparator.comparingDouble(s->s.getValue().getFirst().distanceTo(body)));
        for(var stack:stacks.subList(0,Math.min(stacks.size(),MAX_ITEMS)))
            items.add(obj("item",stack.getKey(),"count",stacked.get(stack.getKey()),"nearest",where(body,stack.getValue().getFirst().position())));

        BlockPos eye=BlockPos.containing(body.getEyePosition());
        String biome=level.getBiome(origin).unwrapKey().map(key->key.location().toString()).orElse("unknown");
        return obj("dimension",level.dimension().location().toString(),"position",obj("x",feet.x,"y",feet.y,"z",feet.z),
            "facing",direction(-Mth.sin(body.getYRot()*Mth.DEG_TO_RAD),Mth.cos(body.getYRot()*Mth.DEG_TO_RAD)),"biome",biome,
            "time",obj("dayTime",Math.floorMod(level.getDayTime(),24000L),"phase",phase(level.getDayTime())),
            "weather",level.isThundering()?"thunder":level.isRaining()?"rain":"clear","openSky",level.canSeeSky(eye),"light",level.getMaxLocalRawBrightness(eye),
            "players",players,"creatures",creatures,"items",items,"blocks",blocks,
            "truncated",obj("blocks",notable.size()>MAX_GROUPS,"creatures",kinds.size()>MAX_CREATURES,"items",stacks.size()>MAX_ITEMS,"players",people.size()>MAX_PLAYERS),
            "budget",obj("radius",radius,"below",BELOW,"above",ABOVE,"columns",columns,"unloadedColumns",unloaded,"loadedOnly",true,"exposedOnly",true));
    }
}
