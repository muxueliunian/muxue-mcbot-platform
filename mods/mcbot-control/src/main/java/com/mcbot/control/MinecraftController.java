package com.mcbot.control;

import com.google.gson.*;
import java.util.*;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.*;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;
import net.neoforged.neoforge.client.event.ClientChatReceivedEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.MovementInputUpdateEvent;
import net.neoforged.neoforge.client.event.InputEvent;
import static com.mcbot.control.Protocol.*;

/** The only version-specific binding. Every entry point runs on the Minecraft main thread. */
final class MinecraftController implements ControlSession.Game {
    static final List<String> CAPABILITIES=List.of("send-chat","look-at","move-to-position","follow-player",
            "dig-block","place-block","open-container","click-slot","close-container");
    private final Minecraft mc=Minecraft.getInstance();
    private final ControlSession session=new ControlSession(this,()->System.nanoTime()/1_000_000);
    private ClientLevel knownLevel;
    private LocalPlayer knownPlayer;
    private boolean knownAlive;
    private String knownDimension;
    private AbstractContainerMenu knownMenu;
    private long menuGeneration,chatSequence;
    private final ArrayDeque<JsonObject> chatHistory=new ArrayDeque<>();
    private ControlSession.Operation active;
    private long deadline,started,lastProgress;
    private Vec3 lastPosition;
    private BlockPos targetBlock;
    private String originalBlock;
    private int initialMenuId;
    private boolean forwardIntent,digStarted;
    private boolean digAwaitingConfirmation;
    private BlockConfirmation blockConfirmation;

    JsonObject call(String method,JsonObject params) { updateWorld(); return session.call(method,params); }
    void tick(ClientTickEvent.Pre event) {
        updateWorld(); session.expire();
        if(active==null) return;
        try {
            if(!session.leased()||mc.player==null||mc.level==null) { stop(); return; }
            long now=System.nanoTime()/1_000_000;
            if(blockConfirmation!=null&&blockConfirmation.confirmed()) {
                finish("succeeded","Server block update confirms the requested target state",obj("source","server-block-update",
                        "block",blockConfirmation.latestServerState(),"observation",blockSnapshot(targetBlock)));
                return;
            }
            if(now>deadline) {
                boolean uncertain=List.of("dig-block","place-block","open-container","click-slot").contains(active.name);
                finish(uncertain?"unknown":"failed",uncertain?"Action timed out after interaction; do not replay without observing":"Action timed out",observationForAction());
                return;
            }
            switch(active.name) {
                case "move-to-position", "follow-player" -> move(now);
                case "dig-block" -> {
                    String current=blockId(targetBlock);
                    if(!current.equals(originalBlock)) {
                        // Stop interacting after the first local change. A correction must not trigger another dig.
                        digAwaitingConfirmation=true;
                        mc.gameMode.stopDestroyBlock();
                    }
                    if(digAwaitingConfirmation) return;
                    requireWorldAction();
                    BlockHitResult hit=checkedHit(targetBlock,null);
                    look(hit.getLocation());
                    // One native interaction per game tick; no desktop mouse capture or synthetic key.
                    if(!digStarted) {
                        digStarted=true;
                        if(!mc.gameMode.startDestroyBlock(targetBlock,hit.getDirection()))
                            throw error("NOT_DIGGABLE","Native client rejected starting this dig");
                    } else mc.gameMode.continueDestroyBlock(targetBlock,hit.getDirection());
                    mc.player.swing(InteractionHand.MAIN_HAND);
                }
                case "open-container" -> {
                    if(mc.player.containerMenu!=mc.player.inventoryMenu&&mc.player.containerMenu.containerId!=initialMenuId) {
                        updateMenu();
                        finish("succeeded","Server opened a menu",containerSnapshot());
                    }
                }
                case "place-block" -> { /* Wait for target-specific inbound server state, never a timer-only success. */ }
                case "click-slot" -> {
                    if(now-started>=600) finish("unknown","Interaction sent; observed state may include client prediction",observationForAction());
                }
                default -> throw error("INTERNAL","Unexpected active action");
            }
        } catch(Protocol.Error e) { finish("failed",e.code+": "+e.getMessage(),null); }
        catch(RuntimeException e) { finish("failed","Client action failed: "+e.getClass().getSimpleName(),null); }
    }
    void serverBlock(ClientPacketListener connection,BlockPos position,BlockState state) {
        if(connection!=mc.getConnection()) return;
        updateWorld();
        if(active==null||blockConfirmation==null||!session.leased()) return;
        blockConfirmation.serverBlock(session.sessionId(),position.asLong(),BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),state.isAir(),blockStateSnapshot(position,state));
    }
    void movementInput(MovementInputUpdateEvent event) {
        if(event.getEntity()!=mc.player||active==null||!session.leased()) return;
        var input=event.getInput();
        input.forwardImpulse=forwardIntent?1:0; input.leftImpulse=0;
        input.up=forwardIntent; input.down=false; input.left=false; input.right=false;
        input.jumping=false; input.shiftKeyDown=false;
    }
    boolean controllingDig() {
        return active!=null&&active.name.equals("dig-block")&&session.leased();
    }
    void manualKey(InputEvent.Key event) {
        if(event.getAction()!=0&&mc.isWindowActive()&&session.leased()) session.revoke("Player took control with keyboard input");
    }
    void manualMouse(InputEvent.MouseButton.Pre event) {
        if(event.getAction()!=0&&mc.isWindowActive()&&session.leased()) session.revoke("Player took control with mouse input");
    }
    private void updateWorld() {
        boolean alive=mc.player!=null&&mc.level!=null&&mc.getConnection()!=null&&mc.player.isAlive();
        String dimension=mc.level==null?null:mc.level.dimension().location().toString();
        if(knownLevel!=mc.level||knownPlayer!=mc.player||knownAlive!=alive||!Objects.equals(knownDimension,dimension)) {
            session.worldChanged(alive?mc.player.getGameProfile().getName():null);
            knownLevel=mc.level; knownPlayer=mc.player; knownAlive=alive; knownDimension=dimension;
            knownMenu=null; menuGeneration=0; chatHistory.clear();
        }
        updateMenu();
    }
    private void updateMenu() {
        AbstractContainerMenu menu=mc.player==null?null:mc.player.containerMenu;
        if(menu!=knownMenu) { knownMenu=menu; menuGeneration++; }
    }
    void chat(ClientChatReceivedEvent event) {
        if(event instanceof ClientChatReceivedEvent.System system&&system.isOverlay()) return;
        updateWorld();
        if(session.sessionId()==null) return;
        JsonObject entry=obj("seq",++chatSequence,"time",System.currentTimeMillis(),"message",event.getMessage().getString());
        if(event instanceof ClientChatReceivedEvent.Player playerEvent&&mc.getConnection()!=null) {
            var info=mc.getConnection().getPlayerInfo(event.getSender());
            if(info!=null) {
                entry.addProperty("username",info.getProfile().getName());
                entry.addProperty("message",playerEvent.getPlayerChatMessage().signedContent());
            }
        }
        chatHistory.add(entry);
        while(chatHistory.size()>100) chatHistory.removeFirst();
    }
    @Override public JsonObject hello() {
        return obj("platform",obj("minecraft","1.21.1","loader","neoforge","loaderVersion","21.1.217"),"capabilities",CAPABILITIES,
                "screen",mc.screen==null?null:mc.screen.getClass().getSimpleName());
    }
    @Override public JsonObject observe(JsonObject params) {
        if(mc.player==null||mc.level==null) throw error("NOT_CONNECTED","Client is not in a world");
        JsonArray inventory=new JsonArray();
        for(int i=0;i<mc.player.getInventory().getContainerSize();i++) inventory.add(item(i,mc.player.getInventory().getItem(i)));
        JsonArray entities=new JsonArray();
        for(Entity entity:mc.level.entitiesForRendering()) {
            if(entity==mc.player||entity.distanceToSqr(mc.player)>32*32) continue;
            entities.add(obj("id",entity.getUUID().toString(),"type",BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString(),
                    "name",entity instanceof Player p?p.getGameProfile().getName():entity.getName().getString(),"position",position(entity.position())));
            if(entities.size()>=64) break;
        }
        JsonObject snapshot=obj("sessionId",session.sessionId(),"worldId",session.worldId(),"connected",true,
                "username",mc.player.getGameProfile().getName(),"dimension",mc.level.dimension().location().toString(),
                "health",mc.player.getHealth(),"food",mc.player.getFoodData().getFoodLevel(),"position",position(mc.player.position()),
                "yaw",mc.player.getYRot(),"pitch",mc.player.getXRot(),"inventory",inventory,"entities",entities,
                "chat",chatHistory,"chatCursor",chatSequence,"container",containerSnapshot(),"source","client-observed");
        if(params.has("block")) snapshot.add("block",blockSnapshot(blockPosition(object(params,"block"))));
        return snapshot;
    }
    private static JsonObject position(Vec3 p) { return obj("x",p.x,"y",p.y,"z",p.z); }
    private static JsonObject item(int slot,ItemStack stack) {
        return obj("slot",slot,"id",stack.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(),"count",stack.getCount());
    }
    private String blockId(BlockPos pos) { return BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(pos).getBlock()).toString(); }
    private JsonObject blockSnapshot(BlockPos pos) {
        if(!mc.level.hasChunkAt(pos)) return obj("position",position(Vec3.atLowerCornerOf(pos)),"state","unloaded");
        return blockStateSnapshot(pos,mc.level.getBlockState(pos));
    }
    private static JsonObject blockStateSnapshot(BlockPos pos,BlockState state) {
        JsonObject props=new JsonObject();
        state.getValues().forEach((property,value)->props.addProperty(property.getName(),value.toString()));
        return obj("position",position(Vec3.atLowerCornerOf(pos)),"state","loaded","id",BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),"properties",props);
    }
    private String menuId() { return session.sessionId()+":"+menuGeneration+":"+mc.player.containerMenu.containerId; }
    private JsonElement containerSnapshot() {
        if(mc.player==null||mc.player.containerMenu==mc.player.inventoryMenu) return JsonNull.INSTANCE;
        updateMenu();
        AbstractContainerMenu menu=mc.player.containerMenu;
        JsonArray slots=new JsonArray();
        for(int i=0;i<menu.slots.size();i++) slots.add(item(i,menu.getSlot(i).getItem()));
        String type;
        try { type=BuiltInRegistries.MENU.getKey(menu.getType()).toString(); }
        catch(RuntimeException e) { type="unknown"; }
        ItemStack carried=menu.getCarried();
        return obj("id",menuId(),"type",type,"slots",slots,"carried",obj("id",carried.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(carried.getItem()).toString(),"count",carried.getCount()));
    }
    @Override public void begin(ControlSession.Operation operation) {
        if(!CAPABILITIES.contains(operation.name)) throw error("UNSUPPORTED","Unknown action");
        if(mc.player==null||mc.level==null||mc.gameMode==null) throw error("NOT_CONNECTED","No playable world");
        JsonObject a=operation.args;
        if(operation.name.equals("send-chat")) {
            String message=string(a,"message");
            if(message.length()>256||message.stripLeading().startsWith("/")||message.chars().anyMatch(c->c<32||c==127||c==167))
                throw error("INVALID_ARGUMENT","Chat must be one ordinary message, up to 256 characters");
            mc.player.connection.sendChat(message);
            operation.finish("succeeded","Message handed to client connection",null); return;
        }
        blockConfirmation=null;
        if(operation.name.equals("look-at")) {
            requireWorldAction(); look(point(a)); operation.finish("succeeded","Client view rotated",null); return;
        }
        if(operation.name.equals("close-container")) {
            requireMenu(a); mc.player.closeContainer(); updateMenu();
            operation.finish("succeeded","Client menu closed; close packet sent",null); return;
        }
        long timeout=(long)bounded(a,"timeoutMs",operation.name.equals("follow-player")?60_000:15_000,500,120_000);
        long now=System.nanoTime()/1_000_000;
        switch(operation.name) {
            case "move-to-position" -> {
                Vec3 target=point(a);
                if(target.distanceTo(mc.player.position())>32) throw error("TOO_FAR","Prototype movement is limited to 32 blocks");
                bounded(a,"tolerance",0.7,0.25,3);
                ensureWalkableClient();
            }
            case "follow-player" -> {
                String name=string(a,"player");
                if(findPlayer(name)==null) throw error("PLAYER_NOT_VISIBLE","Player is not synced within 32 blocks");
                bounded(a,"distance",2.5,1,8); ensureWalkableClient();
            }
            case "dig-block" -> {
                requireWorldAction();
                targetBlock=blockPosition(a); requireBlock(targetBlock,string(a,"expectedBlock"));
                if(mc.level.getBlockState(targetBlock).isAir()||mc.level.getBlockState(targetBlock).getDestroySpeed(mc.level,targetBlock)<0)
                    throw error("NOT_DIGGABLE","Block cannot be dug");
                BlockHitResult hit=checkedHit(targetBlock,null); originalBlock=blockId(targetBlock);
                look(hit.getLocation()); digStarted=false; digAwaitingConfirmation=false;
                blockConfirmation=new BlockConfirmation(session.sessionId(),targetBlock.asLong(),"minecraft:air",true);
            }
            case "place-block" -> {
                requireWorldAction();
                BlockPos support=blockPosition(a); requireBlock(support,string(a,"expectedBlock"));
                BlockState supportState=mc.level.getBlockState(support);
                if(supportState.hasBlockEntity()||supportState.getMenuProvider(mc.level,support)!=null)
                    throw error("UNSUPPORTED","Placement against container or menu blocks is not supported yet");
                Direction face=Direction.byName(string(a,"face"));
                if(face==null) throw error("INVALID_ARGUMENT","Unknown block face");
                targetBlock=support.relative(face);
                if(!mc.level.hasChunkAt(targetBlock)||!mc.level.getBlockState(targetBlock).isAir())
                    throw error("TARGET_OCCUPIED","Placement target must be loaded air");
                int slot=integer(a,"slot");
                if(slot<0||slot>8) throw error("UNSUPPORTED","Place from hotbar slots 0..8 in this prototype");
                ItemStack stack=mc.player.getInventory().getItem(slot);
                requireItem(stack,string(a,"expectedItem"));
                if(!(stack.getItem() instanceof BlockItem blockItem)) throw error("UNSUPPORTED","Only block items are supported");
                BlockHitResult hit=checkedHit(support,face);
                blockConfirmation=new BlockConfirmation(session.sessionId(),targetBlock.asLong(),BuiltInRegistries.BLOCK.getKey(blockItem.getBlock()).toString(),false);
                mc.player.getInventory().selected=slot; look(hit.getLocation());
                mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit);
                mc.player.swing(InteractionHand.MAIN_HAND);
            }
            case "open-container" -> {
                requireWorldAction();
                targetBlock=blockPosition(a); requireBlock(targetBlock,string(a,"expectedBlock"));
                Block block=mc.level.getBlockState(targetBlock).getBlock();
                if(!(block instanceof ChestBlock||block instanceof BarrelBlock||block instanceof HopperBlock
                        ||block instanceof DispenserBlock||block instanceof ShulkerBoxBlock||block instanceof AbstractFurnaceBlock))
                    throw error("UNSUPPORTED","Only standard storage/furnace containers are supported");
                int emptySlot=-1;
                for(int i=0;i<9;i++) if(mc.player.getInventory().getItem(i).isEmpty()) { emptySlot=i; break; }
                if(emptySlot<0) throw error("EMPTY_HAND_REQUIRED","Opening a container requires an empty hotbar slot to prevent item-use fallback");
                BlockHitResult hit=checkedHit(targetBlock,null); look(hit.getLocation());
                initialMenuId=mc.player.containerMenu.containerId;
                int previousSlot=mc.player.getInventory().selected;
                mc.player.getInventory().selected=emptySlot;
                try { mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit); }
                finally { mc.player.getInventory().selected=previousSlot; }
            }
            case "click-slot" -> {
                AbstractContainerMenu menu=requireMenu(a);
                if(!(menu instanceof ChestMenu||menu instanceof HopperMenu||menu instanceof DispenserMenu||menu instanceof ShulkerBoxMenu||menu instanceof AbstractFurnaceMenu))
                    throw error("UNSUPPORTED","Only standard storage/furnace menus are supported");
                int slot=integer(a,"slot");
                if(slot<0||slot>=menu.slots.size()) throw error("INVALID_ARGUMENT","Invalid slot");
                ItemStack stack=menu.getSlot(slot).getItem();
                expectedStack(a,"expectedItem","expectedCount",itemId(stack),stack.getCount());
                ItemStack carried=menu.getCarried();
                expectedStack(a,"expectedCarriedItem","expectedCarriedCount",itemId(carried),carried.getCount());
                int button=a.has("button")?integer(a,"button"):0;
                if(button!=0&&button!=1) throw error("INVALID_ARGUMENT","button must be 0 or 1");
                mc.gameMode.handleInventoryMouseClick(menu.containerId,slot,button,ClickType.PICKUP,mc.player);
            }
            default -> throw error("UNSUPPORTED","Unsupported action");
        }
        active=operation; started=now; deadline=now+timeout; lastProgress=now; lastPosition=mc.player.position();
    }
    private AbstractContainerMenu requireMenu(JsonObject a) {
        updateMenu();
        if(mc.player.containerMenu==mc.player.inventoryMenu||!menuId().equals(string(a,"containerId")))
            throw error("STALE_CONTAINER","Container was closed or replaced");
        return mc.player.containerMenu;
    }
    private void requireBlock(BlockPos pos,String expected) {
        if(!mc.level.hasChunkAt(pos)) throw error("UNLOADED","Target chunk is not loaded");
        if(!blockId(pos).equals(expected)) throw error("STALE_BLOCK","Target block no longer matches expectedBlock");
    }
    private static void requireItem(ItemStack stack,String expected) {
        String actual=itemId(stack);
        if(!actual.equals(expected)) throw error("STALE_ITEM","Item no longer matches expectedItem");
    }
    private static String itemId(ItemStack stack) {
        return stack.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }
    private BlockHitResult checkedHit(BlockPos pos,Direction requestedFace) {
        if(!mc.level.hasChunkAt(pos)) throw error("UNLOADED","Target chunk is not loaded");
        Vec3 destination=Vec3.atCenterOf(pos);
        if(requestedFace!=null) destination=destination.add(Vec3.atLowerCornerOf(requestedFace.getNormal()).scale(0.499));
        Vec3 eyes=mc.player.getEyePosition();
        BlockHitResult hit=mc.level.clip(new ClipContext(eyes,destination,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,mc.player));
        if(hit.getType()!=HitResult.Type.BLOCK||!hit.getBlockPos().equals(pos)||(requestedFace!=null&&hit.getDirection()!=requestedFace))
            throw error("NO_LINE_OF_SIGHT","The requested block face is obstructed");
        if(eyes.distanceTo(hit.getLocation())>mc.player.blockInteractionRange()) throw error("OUT_OF_REACH","Block is beyond player interaction reach");
        return hit;
    }
    private static Vec3 point(JsonObject a) {
        double x=number(a,"x"),y=number(a,"y"),z=number(a,"z");
        if(Math.abs(x)>30_000_000||Math.abs(z)>30_000_000||Math.abs(y)>4096) throw error("INVALID_ARGUMENT","Coordinates outside supported world range");
        return new Vec3(x,y,z);
    }
    private static BlockPos blockPosition(JsonObject a) {
        point(a); return new BlockPos(integer(a,"x"),integer(a,"y"),integer(a,"z"));
    }
    private void look(Vec3 target) {
        Vec3 delta=target.subtract(mc.player.getEyePosition());
        if(delta.lengthSqr()<0.000001) throw error("INVALID_ARGUMENT","Look target coincides with eyes");
        mc.player.setYRot((float)Math.toDegrees(Math.atan2(-delta.x,delta.z)));
        mc.player.setXRot((float)-Math.toDegrees(Math.atan2(delta.y,Math.sqrt(delta.x*delta.x+delta.z*delta.z))));
    }
    private Player findPlayer(String name) {
        return mc.level.players().stream().filter(p->p!=mc.player&&p.getGameProfile().getName().equals(name)&&p.distanceToSqr(mc.player)<=32*32).findFirst().orElse(null);
    }
    private void ensureWalkableClient() {
        requireWorldAction();
        if(mc.player.isPassenger()||mc.player.getAbilities().flying||mc.player.isInWater()||mc.player.isInLava())
            throw error("UNSUPPORTED","Prototype movement requires standing on land");
    }
    private void requireWorldAction() {
        ControlPolicy.worldAction(mc.isPaused(),mc.screen!=null,mc.screen instanceof PauseScreen,mc.player.containerMenu!=mc.player.inventoryMenu);
    }
    private void move(long now) {
        ensureWalkableClient();
        Vec3 target; double tolerance;
        if(active.name.equals("follow-player")) {
            Player player=findPlayer(string(active.args,"player"));
            if(player==null) throw error("PLAYER_NOT_VISIBLE","Follow target left synced range");
            target=player.position(); tolerance=bounded(active.args,"distance",2.5,1,8);
        } else { target=point(active.args); tolerance=bounded(active.args,"tolerance",0.7,0.25,3); }
        Vec3 delta=target.subtract(mc.player.position());
        double horizontal=Math.sqrt(delta.x*delta.x+delta.z*delta.z);
        if(horizontal<=tolerance&&Math.abs(delta.y)<=1.1) {
            clearKeys(); lastProgress=now; lastPosition=mc.player.position();
            if(active.name.equals("move-to-position")) finish("succeeded","Client position reached tolerance",position(mc.player.position()));
            return;
        }
        if(Math.abs(delta.y)>1.1||horizontal>32) throw error("UNSUPPORTED_PATH","Prototype supports nearby level ground; no teleport or automatic digging");
        if(horizontal<0.01) throw error("UNSUPPORTED_PATH","Vertical movement is not supported");
        Vec3 step=new Vec3(delta.x/horizontal,0,delta.z/horizontal).scale(0.7);
        BlockPos next=BlockPos.containing(mc.player.position().add(step));
        if(!mc.level.hasChunkAt(next)) throw error("UNLOADED","Movement would enter an unloaded chunk");
        BlockState feet=mc.level.getBlockState(next),head=mc.level.getBlockState(next.above()),floor=mc.level.getBlockState(next.below());
        if(!feet.getCollisionShape(mc.level,next).isEmpty()||!head.getCollisionShape(mc.level,next.above()).isEmpty())
            throw error("OBSTACLE","Obstacle ahead; prototype will not dig or jump automatically");
        if(!feet.getFluidState().isEmpty()||!floor.getFluidState().isEmpty()||floor.getCollisionShape(mc.level,next.below()).isEmpty()
                ||blockId(next).contains("fire")||blockId(next.below()).equals("minecraft:magma_block"))
            throw error("UNSAFE_PATH","Movement would cross a drop, fluid, or hazardous block");
        if(mc.player.position().distanceToSqr(lastPosition)>0.04) { lastPosition=mc.player.position(); lastProgress=now; }
        if(now-lastProgress>2000) throw error("STUCK","No movement progress for two seconds");
        mc.player.setYRot((float)Math.toDegrees(Math.atan2(-delta.x,delta.z)));
        mc.player.setXRot(0); clearKeys(); forwardIntent=true;
    }
    private JsonElement observationForAction() {
        if(active==null||mc.level==null||mc.player==null) return JsonNull.INSTANCE;
        if(active.name.equals("place-block")||active.name.equals("dig-block"))
            return obj("observation",blockSnapshot(targetBlock),"lastServerBlock",blockConfirmation==null?null:blockConfirmation.latestServerState());
        if(active.name.equals("click-slot")||active.name.equals("open-container")) return containerSnapshot();
        return position(mc.player.position());
    }
    private void finish(String status,String summary,JsonElement result) {
        if(active!=null) active.finish(status,summary,result);
        stop();
    }
    @Override public void stop() {
        if(active!=null) active.finish("cancelled","Client action cancelled",null);
        active=null; blockConfirmation=null; clearKeys();
        if(mc.gameMode!=null) mc.gameMode.stopDestroyBlock();
        if(mc.player!=null) { mc.player.setSprinting(false); mc.player.setShiftKeyDown(false); }
    }
    private void clearKeys() {
        forwardIntent=false;
        if(mc.player!=null&&mc.player.input!=null) {
            mc.player.input.forwardImpulse=0; mc.player.input.leftImpulse=0;
            mc.player.input.up=false; mc.player.input.down=false; mc.player.input.left=false; mc.player.input.right=false;
            mc.player.input.jumping=false; mc.player.input.shiftKeyDown=false;
        }
    }
}
