package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mojang.authlib.GameProfile;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.*;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.neoforged.neoforge.event.entity.player.ItemEntityPickupEvent;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.*;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.ServerChatEvent;
import java.nio.file.Files;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

final class ServerController implements ControlSession.Game {
    static final List<String> CAPABILITIES=List.of("send-chat","look-at","move-to-position","follow-player","follow-companion","dig-block","place-block","open-container","click-slot","close-container","select-slot","drop-item","nearby-blocks","nearby-resources","approach-container","approach-player","approach-resource","pickup-item","companion-pickup");
    private final MinecraftServer server;
    private final ServerConfig config;
    final ControlSession session;
    private final TargetTokens targets;
    private final ResourceTargets resources;
    private final PickupLedger pickups=new PickupLedger();
    private final ValidationProtection validationProtection;
    private SurvivalActions survival;
    private BodyPlayer player;
    private VirtualConnection sink;
    private boolean wasConnected;
    private String lastDimension;
    private ControlSession.Operation active;
    private long actionDeadline, lastProgress;
    private Vec3 progressPosition;
    private List<Vec3> route;
    private int routeIndex;
    private ServerPlayer approachPlayer;
    private Vec3 approachPlayerStart;
    private FollowCompanion companion;
    private PickupItem pickup;
    private final ArrayDeque<JsonObject> chat=new ArrayDeque<>();
    private long chatSequence;
    private ServerChatEvent outgoingChatEvent;
    ServerController(MinecraftServer server,ServerConfig config) {
        this.server=server; this.config=config;
        session=new ControlSession(this,()->System.nanoTime()/1_000_000,config.worldId(),config.username());
        targets=new TargetTokens(session);
        resources=new ResourceTargets(session);
        validationProtection=new ValidationProtection(config.uuid());
    }
    JsonObject call(String method,JsonObject params) { reconcile();return session.call(method,params); }
    @Override public boolean connected() { return player!=null&&player.isAlive()&&!player.isRemoved()&&sink!=null&&sink.isConnected()&&server.getPlayerList().getPlayer(config.uuid())==player&&player.gameMode.getGameModeForPlayer()==GameType.SURVIVAL&&!server.getPlayerList().isOp(player.getGameProfile()); }
    void reconcile() {
        boolean live=connected();
        String dimension=player==null?null:player.serverLevel().dimension().location().toString();
        if(wasConnected!=live||(!Objects.equals(dimension,lastDimension)&&lastDimension!=null)) session.bodyChanged();
        wasConnected=live; lastDimension=dimension;
        session.expire();
    }
    void beforeServerTick() {
        reconcile();
        // Vanilla's real connection ticks independently of entity chunks. Our transport must too.
        // No survival or physics tick here: this only acknowledges teleport and moves PLAYER tickets.
        if(connected()) player.pumpLocalTransport();
    }
    @Override public void ensureBody() {
        if(connected()) return;
        if(player!=null&&!player.isRemoved()&&sink!=null&&sink.isConnected()&&server.getPlayerList().getPlayer(config.uuid())==player) {
            if(server.getPlayerList().isOp(player.getGameProfile())) throw error("FORBIDDEN","Server body refuses an OP identity");
            if(!player.isAlive()) throw error("DEAD_BODY","Body is dead; use explicit native respawn before claiming control");
            throw error("FORBIDDEN","Existing body is not in survival mode; no automatic game-mode change");
        }
        if(player!=null) remove();
        if(server.getPlayerList().getPlayer(config.uuid())!=null||server.getPlayerList().getPlayerByName(config.username())!=null) throw error("WRONG_PLAYER","Configured player identity is already occupied");
        GameProfile profile=new GameProfile(config.uuid(),config.username());
        if(server.getPlayerList().isOp(profile)) throw error("FORBIDDEN","Server body refuses an OP identity");
        boolean persisted=Files.exists(server.getWorldPath(LevelResource.PLAYER_DATA_DIR).resolve(config.uuid()+".dat"));
        sink=new VirtualConnection(); player=new BodyPlayer(server,server.overworld(),profile,this);
        CommonListenerCookie cookie=CommonListenerCookie.createInitial(profile,false);
        try {
            server.getPlayerList().placeNewPlayer(sink,player,cookie);
            player.connection=new VirtualGameListener(server,sink,player,cookie); sink.setVirtualListener(player.connection);
            survival=new SurvivalActions(player,session,targets,resources);
            if(!player.isAlive()) {
                // Keep vanilla's dead body for explicit PERFORM_RESPAWN, never grant an action lease.
                session.bodyChanged();
                throw error("DEAD_BODY","Saved body is dead; explicitly respawn through the native player path");
            }
            if(!persisted) player.setGameMode(GameType.SURVIVAL);
            if(player.gameMode.getGameModeForPlayer()!=GameType.SURVIVAL) throw error("FORBIDDEN","Saved body is not in survival mode");
            player.setInvulnerable(false);
            if(!persisted&&config.spawnX()!=null) player.teleportTo(server.overworld(),config.spawnX(),config.spawnY(),config.spawnZ(),Set.of(),0,0);
            // placeNewPlayer registered a ticket at the old/default position. Transfer it now,
            // otherwise the new unloaded chunk cannot tick the entity that would transfer it.
            player.pumpLocalTransport();
            player.stopInput(); wasConnected=true; lastDimension=player.serverLevel().dimension().location().toString(); session.bodyChanged();
        } catch(Protocol.Error failure) { if(!failure.code.equals("DEAD_BODY")) remove();throw failure; }
        catch(RuntimeException failure) { remove(); throw failure; }
    }
    @Override public void respawn() {
        if(server.getPlayerList().isOp(new GameProfile(config.uuid(),config.username()))) throw error("FORBIDDEN","Server body refuses an OP identity");
        if(player!=null&&(player.isRemoved()||sink==null||!sink.isConnected()||server.getPlayerList().getPlayer(config.uuid())!=player)) remove();
        if(player==null) {
            NativeRespawn.requireDeadSave(server,config.uuid());
            try { ensureBody(); } catch(Protocol.Error failure) { if(!failure.code.equals("DEAD_BODY")) throw failure; }
        }
        if(survival!=null) survival.stop();
        player=NativeRespawn.perform(player);survival=new SurvivalActions(player,session,targets,resources);
        player.stopInput();player.pumpLocalTransport();wasConnected=connected();lastDimension=player.serverLevel().dimension().location().toString();
    }
    @Override public JsonObject hello() {
        JsonObject hello=obj("platform",obj("minecraft","1.21.1","loader","neoforge","loaderVersion","21.1.217"),"capabilities",CAPABILITIES);
        if(validationProtection.enabled()) hello.add("validationFixture",validationProtection.json());
        return hello;
    }
    @Override public JsonObject observe(JsonObject params) {
        JsonArray inventory=new JsonArray(),entities=new JsonArray();
        for(int i=0;i<player.getInventory().getContainerSize();i++) inventory.add(survival.stack(i,player.getInventory().getItem(i)));
        for(Entity entity:player.serverLevel().getEntities(player,player.getBoundingBox().inflate(32))) {
            if(entity.distanceToSqr(player)>32*32) continue;
            entities.add(obj("id",entity.getUUID().toString(),"type",BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString(),"name",entity instanceof Player p?p.getGameProfile().getName():entity.getName().getString(),"position",position(entity.position())));
            if(entities.size()>=64) break;
        }
        JsonObject result=obj("connected",true,"username",config.username(),"dimension",player.serverLevel().dimension().location().toString(),"health",player.getHealth(),"food",player.getFoodData().getFoodLevel(),"position",position(player.position()),"yaw",player.getYRot(),"pitch",player.getXRot(),"inventory",inventory,"selectedSlot",player.getInventory().selected,"entities",entities,"chat",chat,"chatCursor",chatSequence,"container",survival.container(),"source","server-observed");
        JsonObject drops=groundItems();drops.entrySet().forEach(entry->result.add(entry.getKey(),entry.getValue()));
        pickups.observation().entrySet().forEach(entry->result.add(entry.getKey(),entry.getValue()));
        if(params.has("block")) {
            Vec3 requested=point(object(params,"block")); BlockPos block=BlockPos.containing(requested);
            JsonObject state=obj("position",position(Vec3.atLowerCornerOf(block)),"state","unloaded");
            if(player.serverLevel().hasChunkAt(block)) {
                var actual=player.serverLevel().getBlockState(block); JsonObject properties=new JsonObject();
                actual.getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString()));
                state=obj("position",position(Vec3.atLowerCornerOf(block)),"state","loaded","id",BuiltInRegistries.BLOCK.getKey(actual.getBlock()).toString(),"properties",properties);
            }
            result.add("block",state);
        }
        return result;
    }
    @Override public JsonObject nearbyBlocks(JsonObject params) {
        NearbyBlocks.Options options=NearbyBlocks.options(params);
        ServerPlayer center=player;
        if(options.centerPlayer()!=null&&!options.centerPlayer().equals(player.getGameProfile().getName())) {
            center=findPlayer(options.centerPlayer());
            if(center==null||!NearbyBlocks.visiblePlayer(player,center))
                throw error("INVALID_ARGUMENT","Center player must be visible within 32 blocks in the same dimension");
        }
        return NearbyBlocks.discover(player,center,options,targets);
    }
    @Override public JsonObject nearbyResources(JsonObject params) {return NearbyResources.discover(player,params,resources);}
    private JsonObject groundItems() {
        List<ItemEntity> items=player.serverLevel().getEntitiesOfClass(ItemEntity.class,player.getBoundingBox().inflate(8),e->e.isAlive()&&!e.isRemoved()&&e.distanceToSqr(player)<=64&&!e.getItem().isEmpty());
        items.sort(Comparator.comparingDouble((ItemEntity e)->e.distanceToSqr(player)).thenComparing(e->e.getUUID().toString()));
        JsonArray result=new JsonArray();boolean truncated=items.size()>32;
        for(ItemEntity item:items.subList(0,Math.min(32,items.size()))) {
            try {
                String visibility=new FlatApproach(player).itemVisibility(item.position());
                result.add(groundObservation(item.getUUID().toString(),position(item.position()),survival.stackValue(item.getItem()),visibility,item.onGround()));
            }catch(Protocol.Error unsupported){truncated=true;}
        }
        return obj("groundItems",result,"groundItemsTruncated",truncated);
    }
    static JsonObject groundObservation(String entityId,JsonObject position,JsonObject stack,String visibility,boolean onGround) {
        return obj("entityId",entityId,"position",position,"stack",stack,"visibility",visibility,
            "visible",visibility.equals("unknown")?null:visibility.equals("visible"),"onGround",onGround);
    }
    void receivePickup(ItemEntityPickupEvent.Post event) {
        if(player==null||survival==null)return;
        ItemEntity entity=event.getItemEntity();
        if(event.getPlayer()!=player&&(pickup==null||!pickup.targets(entity)))return;
        try {
            JsonObject original=survival.stackValue(event.getOriginalStack()),remaining=survival.stackValue(event.getCurrentStack());
            int count=PickupLedger.pickedUpCount(original,remaining);JsonObject portion=original.deepCopy();portion.addProperty("count",count);
            if(event.getPlayer()==player)pickups.record(entity.getUUID().toString(),position(entity.position()),original,remaining,session.sessionId(),session.generation(),player.serverLevel().dimension().location().toString());
            if(pickup!=null)pickup.picked(entity,event.getPlayer()==player,portion,count);
        }catch(RuntimeException unknown){if(event.getPlayer()==player)pickups.unknown();if(pickup!=null)pickup.fail("PICKUP_UNKNOWN","Native pickup stack could not be attributed completely");}
    }
    @Override public JsonObject watch() { return obj("chat",chat,"chatCursor",chatSequence); }
    @Override public long chatCursor() { return chatSequence; }
    void receiveChat(ServerChatEvent event) {
        if(event!=outgoingChatEvent&&!event.isCanceled()) recordChat(event.getUsername(),event.getMessage().getString());
    }
    private void recordChat(String username,String message) {
        chat.addLast(obj("seq",++chatSequence,"time",System.currentTimeMillis(),"username",username,"message",message));
        while(chat.size()>100) chat.removeFirst();
    }
    @Override public void begin(ControlSession.Operation operation) {
        if(!atomicAction(operation.name)) throw error("UNSUPPORTED","Action is not available");
        if(!session.mayDrive(operation)) throw error("LEASE_LOST","Body lease expired before action");
        JsonObject args=operation.args;
        if(survival.handles(operation.name)) { survival.begin(operation);return; }
        if(operation.name.equals("send-chat")) {
            String message=string(args,"message");
            if(message.length()>256||message.stripLeading().startsWith("/")||message.chars().anyMatch(c->c<32||c==127||c==167)) throw error("INVALID_ARGUMENT","Chat must be one ordinary message up to 256 characters");
            ServerChatEvent event=new ServerChatEvent(player,message,Component.literal(message));
            outgoingChatEvent=event;
            try { NeoForge.EVENT_BUS.post(event); }
            finally { outgoingChatEvent=null; }
            if(event.isCanceled()) throw error("FORBIDDEN","Server chat event cancelled message");
            if(!session.mayDrive(operation)) throw error("LEASE_LOST","Lease expired while chat event was processing");
            server.getPlayerList().broadcastSystemMessage(Component.literal("<"+config.username()+"> ").append(event.getMessage()),false);
            recordChat(config.username(),event.getMessage().getString());
            operation.finish("succeeded","Server broadcast message",null); return;
        }
        if(operation.name.equals("look-at")) { look(point(args)); operation.finish("succeeded","Server view rotated",null); return; }
        if(operation.name.equals("approach-container")||operation.name.equals("approach-player")||operation.name.equals("approach-resource")) { beginApproach(operation);return; }
        if(operation.name.equals("pickup-item")) {pickup=PickupItem.create(operation,player,session,survival);active=operation;pickup.tick();if(!operation.status.equals("running"))stop();return;}
        if(operation.name.equals("follow-companion")) {
            companion=FollowCompanion.create(operation,player,session,server);active=operation;
            companion.tick();if(!operation.status.equals("running")) stop();return;
        }
        long timeout=(long)bounded(args,"timeoutMs",operation.name.equals("follow-player")?60_000:15_000,500,120_000);
        if(operation.name.equals("move-to-position")) {
            Vec3 target=point(args); if(target.distanceTo(player.position())>32) throw error("INVALID_ARGUMENT","Movement limited to 32 blocks");
            bounded(args,"tolerance",0.7,0.25,3);
        } else {
            String name=string(args,"player"); bounded(args,"distance",2.5,1,8);
            if(findPlayer(name)==null) throw error("INVALID_ARGUMENT","Target player is not within 32 blocks in this dimension");
        }
        requireWalkable(); active=operation; actionDeadline=now()+timeout; lastProgress=now(); progressPosition=player.position();
    }
    static boolean atomicAction(String name){return CAPABILITIES.contains(name)&&!Set.of("nearby-blocks","nearby-resources","companion-pickup").contains(name);}
    void beforePhysics(BodyPlayer body) {
        if(body!=player) { body.stopInput(); return; }
        reconcile();
        if(survival!=null) survival.tick();
        if(active==null) { body.stopInput(); return; }
        if(!session.mayDrive(active)) { stop(); return; }
        if(companion!=null) {
            companion.tick();if(active!=null&&!active.status.equals("running")) stop();return;
        }
        if(pickup!=null){pickup.tick();if(active!=null&&!active.status.equals("running"))stop();return;}
        try {
            if(active.name.equals("approach-container")||active.name.equals("approach-player")||active.name.equals("approach-resource")) {tickApproach();return;}
            if(now()>=actionDeadline) { finish(active.name.equals("follow-player")?"succeeded":"failed","Movement time limit reached"); return; }
            requireWalkable();
            Vec3 target;
            double tolerance;
            if(active.name.equals("follow-player")) {
                ServerPlayer followed=findPlayer(string(active.args,"player"));
                if(followed==null) throw error("INVALID_ARGUMENT","Followed player left local range or dimension");
                target=followed.position(); tolerance=bounded(active.args,"distance",2.5,1,8);
            } else { target=point(active.args); tolerance=bounded(active.args,"tolerance",0.7,0.25,3); }
            Vec3 delta=target.subtract(player.position());
            if(Math.abs(delta.y)>1.2) throw error("INVALID_ARGUMENT","Only level-ground movement is supported");
            if(delta.horizontalDistance()<=tolerance) {
                player.stopInput(); lastProgress=now(); progressPosition=player.position();
                if(active.name.equals("move-to-position")) finish("succeeded","Reached server-observed target");
                return;
            }
            if(delta.horizontalDistance()>32) throw error("INVALID_ARGUMENT","Target moved beyond 32 blocks");
            if(player.position().distanceToSqr(progressPosition)>0.04) { lastProgress=now(); progressPosition=player.position(); }
            if(now()-lastProgress>1500) throw error("BLOCKED","Movement made no progress");
            Vec3 step=new Vec3(delta.x,0,delta.z).normalize().scale(0.6);
            AABB ahead=player.getBoundingBox().move(step);
            BlockPos support=BlockPos.containing(player.position().add(step).add(0,-0.1,0));
            BlockPos foot=BlockPos.containing(player.position().add(step)), head=foot.above();
            if(!player.serverLevel().hasChunkAt(support)||!player.serverLevel().hasChunkAt(foot)||!player.serverLevel().hasChunkAt(head)||!player.serverLevel().noCollision(player,ahead)||player.serverLevel().getBlockState(support).getCollisionShape(player.serverLevel(),support).isEmpty()||hazard(support)||hazard(foot)||hazard(head)) throw error("BLOCKED","Obstacle, missing support, danger, liquid, or unloaded terrain");
            if(!session.mayDrive(active)) { stop(); return; }
            player.moveInput(delta.x,delta.z);
        } catch(Protocol.Error e) { finish("failed",e.code+": "+e.getMessage(),obj("code",e.code,"position",position(player.position()))); }
        catch(RuntimeException e) { finish("failed","Movement failed: "+e.getClass().getSimpleName()); }
    }
    private void beginApproach(ControlSession.Operation operation) {
        requireWalkable();
        long timeout=(long)bounded(operation.args,"timeoutMs",15_000,500,120_000);
        BlockPos container=null;ServerPlayer recipient=null;
        if(operation.name.equals("approach-resource")) {
            container=resources.require(player,string(operation.args,"targetToken")).position();
            if(Vec3.atCenterOf(container).distanceTo(player.position())>16)throw error("OUT_OF_REACH","Resource approach is limited to sixteen blocks");
        } else if(operation.name.equals("approach-container")) {
            container=targets.require(player,string(operation.args,"targetToken")).position();
            if(Vec3.atCenterOf(container).distanceTo(player.position())>32) throw error("INVALID_ARGUMENT","Container approach limited to 32 blocks");
        } else {
            bounded(operation.args,"distance",1.3,1,1.5);
            recipient=findPlayer(string(operation.args,"player"));
            if(recipient==null) throw error("STALE_TARGET","Recipient left local range or dimension");
            if(operation.args.has("expectedEntityId")&&!recipient.getUUID().toString().equals(string(operation.args,"expectedEntityId"))) throw error("STALE_TARGET","Recipient entity identity changed");
        }
        FlatApproach geometry=new FlatApproach(player);
        if(!geometry.safe(player.position(),player.position())) throw error("BLOCKED","Current full body/sole is not on safe loaded flat ground");
        final BlockPos targetBlock=container;final ServerPlayer targetPlayer=recipient;
        java.util.function.Predicate<Vec3> goal=feet->targetBlock!=null?geometry.containerReach(feet,targetBlock):geometry.playerReach(feet,targetPlayer,bounded(operation.args,"distance",1.3,1,1.5));
        if(goal.test(player.position())) {
            operation.finish("succeeded","Already at a verified interaction position",approachResult(operation,recipient));return;
        }
        FlatRoute.Cell origin=new FlatRoute.Cell(player.blockPosition().getX(),player.blockPosition().getZ());
        Vec3 center=geometry.point(origin);
        if(!geometry.safe(player.position(),center)) throw error("BLOCKED","Cannot safely enter the flat route grid");
        List<FlatRoute.Cell> cells=FlatRoute.plan(origin,new FlatRoute.View() {
            public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to) {return geometry.safe(geometry.point(from),geometry.point(to));}
            public boolean goal(FlatRoute.Cell cell) {return FlatApproach.arrivalStand(geometry.point(cell),goal);}
        });
        if(!session.mayDrive(operation)) throw error("LEASE_LOST","Control expired while planning route");
        route=cells.stream().map(geometry::point).toList();routeIndex=0;
        approachPlayer=recipient;approachPlayerStart=recipient==null?null:recipient.position();
        active=operation;actionDeadline=now()+timeout;lastProgress=now();progressPosition=player.position();
    }
    private JsonObject approachResult(ControlSession.Operation operation,ServerPlayer recipient) {
        JsonObject result=obj("position",position(player.position()));
        if(operation.name.equals("approach-container")||operation.name.equals("approach-resource")) result.addProperty("targetToken",string(operation.args,"targetToken"));
        else {result.addProperty("player",recipient.getGameProfile().getName());result.addProperty("entityId",recipient.getUUID().toString());}
        return result;
    }
    private void tickApproach() {
        requireWalkable();
        if(now()>=actionDeadline) throw error("TIMEOUT","Approach time limit reached");
        FlatApproach geometry=new FlatApproach(player);
        if(!geometry.safe(player.position(),player.position())) throw error("BLOCKED","Current swept body/whole sole is no longer safe loaded ground");
        boolean reached;
        if(active.name.equals("approach-container")||active.name.equals("approach-resource")) {
            BlockPos pos=active.name.equals("approach-resource")?resources.require(player,string(active.args,"targetToken")).position():targets.require(player,string(active.args,"targetToken")).position();
            reached=geometry.containerReach(player.position(),pos);
        } else {
            ServerPlayer actual=findPlayer(string(active.args,"player"));
            if(actual!=approachPlayer) throw error("STALE_TARGET","Recipient entity changed or left local range/dimension");
            if(actual.position().distanceTo(approachPlayerStart)>0.5) throw error("TARGET_MOVED","Recipient moved during approach; request a new bounded approach");
            reached=geometry.playerReach(player.position(),actual,bounded(active.args,"distance",1.3,1,1.5));
        }
        if(reached) {JsonObject result=approachResult(active,approachPlayer);finish("succeeded","Reached verified interaction position",result);return;}
        while(routeIndex<route.size()&&player.position().subtract(route.get(routeIndex)).horizontalDistance()<0.15) routeIndex++;
        if(routeIndex>=route.size()) throw error("BLOCKED","Route ended without authoritative interaction reach");
        Vec3 next=route.get(routeIndex),delta=next.subtract(player.position());
        // Recheck the remaining route every tick, including its swept body and full sole.
        Vec3 start=player.position();
        for(int i=routeIndex;i<route.size();i++) {
            Vec3 end=route.get(i);
            if(!geometry.safe(start,end)) throw error("BLOCKED","Route changed: collision, missing full support, danger or unloaded terrain");
            start=end;
        }
        if(player.position().distanceToSqr(progressPosition)>0.04) {lastProgress=now();progressPosition=player.position();}
        if(now()-lastProgress>1500) throw error("BLOCKED","Approach made no progress");
        Vec3 step=new Vec3(delta.x,0,delta.z).normalize().scale(Math.min(0.6,delta.horizontalDistance()));
        if(!geometry.safe(player.position(),player.position().add(step))) throw error("BLOCKED","Next physical step is no longer safe");
        if(!session.mayDrive(active)) {stop();return;}
        player.moveInput(delta.x,delta.z);
    }
    private void requireWalkable() {
        if(player.containerMenu!=player.inventoryMenu) throw error("BUSY","Close the container before moving");
        if(!connected()||player.isInWater()||player.isInLava()||player.isPassenger()||player.isFallFlying()) throw error("BLOCKED","Body cannot safely walk");
        if(!player.onGround()) throw error("BLOCKED","Body is airborne; flat-ground prototype stopped");
    }
    private boolean hazard(BlockPos position) {
        var state=player.serverLevel().getBlockState(position);
        return !player.serverLevel().getFluidState(position).isEmpty()||state.is(Blocks.MAGMA_BLOCK)||state.is(Blocks.CACTUS)||state.is(Blocks.FIRE)||state.is(Blocks.SOUL_FIRE)||state.is(Blocks.SWEET_BERRY_BUSH)||state.is(Blocks.POWDER_SNOW)||state.is(Blocks.WITHER_ROSE)||state.is(Blocks.CAMPFIRE)||state.is(Blocks.SOUL_CAMPFIRE);
    }
    private ServerPlayer findPlayer(String name) {
        ServerPlayer target=server.getPlayerList().getPlayerByName(name);
        return target!=null&&target!=player&&target.isAlive()&&target.serverLevel()==player.serverLevel()&&target.distanceToSqr(player)<=32*32?target:null;
    }
    private void finish(String status,String summary) {
        finish(status,summary,obj("position",position(player.position())));
    }
    private void finish(String status,String summary,JsonObject result) {
        if(active!=null) active.finish(status,summary,result);
        stop();
    }
    @Override public void stop() { active=null;route=null;approachPlayer=null;approachPlayerStart=null; if(companion!=null) companion.stop();companion=null;if(pickup!=null)pickup.stop();pickup=null; if(player!=null) player.stopInput();if(survival!=null) survival.stop(); }
    @Override public void abort(ControlSession.Operation operation) { if(active==operation) stop();else if(survival!=null) survival.abort(operation); }
    void remove() {
        session.revokeCurrent("Server body removed");
        BodyPlayer old=player; VirtualConnection oldSink=sink; player=null; sink=null;survival=null;
        if(old!=null) {
            old.stopInput();
            if(old.connection instanceof VirtualGameListener listener) listener.clearPendingMotion();
            if(server.getPlayerList().getPlayer(config.uuid())==old) old.connection.onDisconnect(new DisconnectionDetails(Component.literal("MCBOT server body removed")));
            else if(!old.isRemoved()) { old.serverLevel().removePlayerImmediately(old,Entity.RemovalReason.DISCARDED); old.getTextFilter().leave(); }
        }
        if(oldSink!=null) oldSink.closeSink();
        wasConnected=false; lastDimension=null;
    }
    void close() { remove();validationProtection.close(); }
    private void look(Vec3 target) {
        Vec3 delta=target.subtract(player.getEyePosition());
        float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z));
        float pitch=(float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance()));
        player.setYRot(yaw); player.setYHeadRot(yaw); player.setXRot(pitch);
    }
    private static long now() { return System.nanoTime()/1_000_000; }
    private static Vec3 point(JsonObject args) {
        number(args,"x"); number(args,"y"); number(args,"z");
        return new Vec3(bounded(args,"x",0,-29_999_000,29_999_000),bounded(args,"y",0,-2048,2048),bounded(args,"z",0,-29_999_000,29_999_000));
    }
    private static JsonObject position(Vec3 point) { return obj("x",point.x,"y",point.y,"z",point.z); }
    private static JsonObject item(int slot,ItemStack item) { return obj("slot",slot,"id",item.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(item.getItem()).toString(),"count",item.getCount()); }
}
