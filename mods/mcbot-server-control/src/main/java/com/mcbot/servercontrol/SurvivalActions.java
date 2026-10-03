package com.mcbot.servercontrol;

import com.google.gson.*;
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import net.minecraft.core.*;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.RegistryOps;
import net.minecraft.nbt.*;
import net.minecraft.network.protocol.game.*;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.inventory.*;
import net.minecraft.world.item.*;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;
import com.mcbot.servercontrol.mixin.ServerPlayerGameModeAccessor;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Ordinary player packet entry points, with authoritative preconditions and no client prediction. */
final class SurvivalActions {
    static final List<String> CAPABILITIES=List.of("dig-block","place-block","open-container","click-slot","close-container","select-slot","drop-item");
    private final ServerPlayer player;
    private final ControlSession session;
    private final TargetTokens targets;
    private final ResourceTargets resources;
    private String guardedToken;
    private TargetTokens.Target guardedTarget;
    private AbstractContainerMenu guardedMenu;
    private ControlSession.Operation digging;
    private BlockPos digPosition;
    private Direction digFace;
    private BlockState digState;
    private JsonObject digHand;
    private int digSlot,lastDigTick=Integer.MIN_VALUE,sequence;
    private long deadline;
    private AbstractContainerMenu knownMenu;
    private JsonObject knownMenuState;
    private long menuGeneration,revision;
    private final NativeActionBoundary nativeEffects=new NativeActionBoundary();
    SurvivalActions(ServerPlayer player,ControlSession session,TargetTokens targets,ResourceTargets resources) { this.player=player;this.session=session;this.targets=targets;this.resources=resources; }
    boolean handles(String name) { return CAPABILITIES.contains(name); }
    private ServerPlayerGameModeAccessor mining() { return (ServerPlayerGameModeAccessor)player.gameMode; }
    private static long now() { return System.nanoTime()/1_000_000; }
    static int integer(JsonObject object,String key) {
        double value=number(object,key);
        if(value!=Math.rint(value)||value<Integer.MIN_VALUE||value>Integer.MAX_VALUE) throw error("INVALID_ARGUMENT",key+" must be an integer");
        return (int)value;
    }
    private void guard(ControlSession.Operation operation) {
        if(!session.mayDrive(operation)) throw error("LEASE_LOST","Control expired before native interaction");
        if(player.gameMode.getGameModeForPlayer()!=GameType.SURVIVAL) throw error("FORBIDDEN","Survival interactions require a survival body");
        if(player.connection instanceof VirtualGameListener listener) listener.acknowledgeTeleport();
    }
    private void worldAction() {
        if(player.containerMenu!=player.inventoryMenu) throw error("BUSY","Close the current container before a world action");
        if(player.isPassenger()||player.isSleeping()||player.isUsingItem()) throw error("BUSY","Body is occupied");
    }
    JsonObject stackValue(ItemStack stack) {
        JsonObject value=obj("id",itemId(stack),"count",stack.getCount(),"components",components(stack));
        if(!stack.isEmpty())value.addProperty("maxStackSize",stack.getMaxStackSize());return value;
    }
    JsonObject stack(int slot,ItemStack stack) {JsonObject value=stackValue(stack);value.addProperty("slot",slot);return value;}
    JsonObject components(ItemStack stack) {
        if(stack.isEmpty()) return new JsonObject();
        for(var component:stack.getComponents()) if(component.type().isTransient())
            throw error("UNSUPPORTED","Transient item component has no complete persistent codec: "+BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(component.type()));
        Tag encoded=DataComponentMap.CODEC.encodeStart(RegistryOps.create(NbtOps.INSTANCE,player.registryAccess()),stack.getComponents()).result()
            .orElseThrow(()->error("UNSUPPORTED","Item components cannot be serialized; refusing an incomplete item guard"));
        if(!(encoded instanceof CompoundTag values)) throw error("UNSUPPORTED","Item components have no complete compound representation");
        JsonObject result=new JsonObject();
        for(String name:values.getAllKeys()) result.add(name,ExactNbt.encode(values.get(name)));
        return result;
    }
    private static String itemId(ItemStack stack) { return stack.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(); }
    private JsonObject hand() { return stack(player.getInventory().selected,player.getMainHandItem()); }
    private JsonArray inventory() {
        JsonArray result=new JsonArray();
        for(int i=0;i<player.getInventory().getContainerSize();i++) result.add(stack(i,player.getInventory().getItem(i)));
        return result;
    }
    private void expectedItem(JsonObject args,String itemKey,String countKey,String componentKey,ItemStack stack) {
        if(!string(args,itemKey).equals(itemId(stack))||integer(args,countKey)!=stack.getCount()||!object(args,componentKey).equals(components(stack)))
            throw error("STALE_ITEM","Item ID, count or components changed; observe again");
        if(args.has("expectedMaxStackSize")&&(stack.isEmpty()||integer(args,"expectedMaxStackSize")!=stack.getMaxStackSize()))
            throw error("STALE_ITEM","Effective stack maximum changed before native write");
    }
    private int hotbar(JsonObject args) {
        int slot=integer(args,"slot");
        if(slot<0||slot>8) throw error("INVALID_ARGUMENT","slot must be a hotbar slot 0..8");
        return slot;
    }
    private void select(int slot) { player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(slot)); }
    private static BlockPos block(JsonObject args) {
        int x=integer(args,"x"),y=integer(args,"y"),z=integer(args,"z");
        if(Math.abs((long)x)>29_999_000||Math.abs((long)z)>29_999_000||Math.abs((long)y)>2048) throw error("INVALID_ARGUMENT","Block coordinates out of bounds");
        return new BlockPos(x,y,z);
    }
    private BlockState expectedBlock(JsonObject args,BlockPos position) {
        if(!player.serverLevel().hasChunkAt(position)) throw error("UNLOADED","Target chunk is not loaded");
        BlockState state=player.serverLevel().getBlockState(position);
        if(!string(args,"expectedBlock").equals(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString())||!object(args,"expectedProperties").equals(properties(state)))
            throw error("STALE_BLOCK","Block ID or properties changed");
        return state;
    }
    private static JsonObject properties(BlockState state) {
        JsonObject properties=new JsonObject(); state.getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString())); return properties;
    }
    private JsonObject blockSnapshot(BlockPos position) {
        BlockState state=player.serverLevel().getBlockState(position);
        return obj("position",obj("x",position.getX(),"y",position.getY(),"z",position.getZ()),"id",BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),"properties",properties(state));
    }
    private BlockHitResult hit(BlockPos position,Direction requestedFace) {
        if(!player.serverLevel().hasChunkAt(position)) throw error("UNLOADED","Interaction target is unloaded");
        Vec3 destination=Vec3.atCenterOf(position);
        if(requestedFace!=null) destination=destination.add(Vec3.atLowerCornerOf(requestedFace.getNormal()).scale(0.499));
        BlockHitResult hit=player.serverLevel().clip(new ClipContext(player.getEyePosition(),destination,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        if(hit.getType()!=HitResult.Type.BLOCK||!hit.getBlockPos().equals(position)||(requestedFace!=null&&hit.getDirection()!=requestedFace)) throw error("NO_LINE_OF_SIGHT","Block face is obstructed");
        if(player.getEyePosition().distanceTo(hit.getLocation())>player.blockInteractionRange()) throw error("OUT_OF_REACH","Target exceeds ordinary block reach");
        if(!player.serverLevel().getWorldBorder().isWithinBounds(position)) throw error("FORBIDDEN","Target outside world border");
        return hit;
    }
    private void look(Vec3 target) {
        Vec3 delta=target.subtract(player.getEyePosition());float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z));
        player.setYRot(yaw);player.setYHeadRot(yaw);player.setXRot((float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance())));
    }
    private void action(ServerboundPlayerActionPacket.Action action,BlockPos position,Direction face) {
        player.connection.handlePlayerAction(new ServerboundPlayerActionPacket(action,position,face,++sequence));
    }
    private boolean standard(AbstractContainerMenu menu) { return menu instanceof ChestMenu||menu instanceof HopperMenu||menu instanceof DispenserMenu||menu instanceof ShulkerBoxMenu||menu instanceof AbstractFurnaceMenu||IronFurnaceAdapter.menu(menu); }
    JsonElement container() {
        AbstractContainerMenu menu=player.containerMenu;
        if(menu==player.inventoryMenu) { knownMenu=null;knownMenuState=null;guardedToken=null;guardedTarget=null;guardedMenu=null;return JsonNull.INSTANCE; }
        verifyGuardedMenu();
        if(!standard(menu)) throw error("UNSUPPORTED","Only ordinary storage/furnace menus are supported");
        menu.broadcastChanges();
        if(menu!=knownMenu) { knownMenu=menu;knownMenuState=null;menuGeneration++;revision=0; }
        var storage=MenuSlotSources.storage(menu,player.getInventory());
        boolean ironFurnace=IronFurnaceAdapter.menu(menu);
        if(ironFurnace&&storage==null) throw error("UNSUPPORTED","Iron furnace native slot contract changed");
        JsonArray slots=new JsonArray();for(int i=0;i<menu.slots.size();i++) {
            Slot slot=menu.getSlot(i);
            JsonObject observed=MenuSlotSources.annotate(stack(i,slot.getItem()),slot,player.getInventory(),storage,ironFurnace);
            observed.addProperty("active",slot.isActive());observed.addProperty("mayPickup",slot.mayPickup(player));slots.add(observed);
        }
        ItemStack carried=menu.getCarried();
        String type=BuiltInRegistries.MENU.getKey(menu.getType()).toString();
        JsonObject state=obj("type",type,"slots",slots,"carried",stackValue(carried),"nativeStateId",menu.getStateId());
        if(knownMenuState!=null&&!knownMenuState.equals(state)) revision++;
        knownMenuState=state.deepCopy();
        state.remove("nativeStateId");state.addProperty("id",session.sessionId()+":"+menuGeneration+":"+menu.containerId);state.addProperty("revision",revision);return state;
    }
    private AbstractContainerMenu menu(JsonObject args) {
        JsonElement observed=container();
        if(observed.isJsonNull()||!observed.getAsJsonObject().get("id").getAsString().equals(string(args,"containerId"))) throw error("STALE_CONTAINER","Menu closed or replaced");
        double expected=number(args,"expectedRevision");
        if(expected!=Math.rint(expected)||expected<0||expected>9_007_199_254_740_991d) throw error("INVALID_ARGUMENT","Invalid expectedRevision");
        if((long)expected!=revision) throw error("STALE_CONTAINER","Menu slots, carried stack or revision changed");
        if(!player.containerMenu.stillValid(player)) throw error("STALE_CONTAINER","Menu no longer valid at this position");
        return player.containerMenu;
    }
    private void verifyGuardedMenu() {
        if(guardedToken==null) return;
        if(player.containerMenu!=guardedMenu) throw error("STALE_TARGET","Guarded menu was replaced");
        targets.requireBound(player,guardedTarget);
        targets.requireMenu(player,guardedTarget,guardedMenu);
    }
    void begin(ControlSession.Operation operation) {
        nativeEffects.reset();
        try {
            nativeEffects.begin(operation,()-> {
            guard(operation);
            switch(operation.name) {
                case "dig-block" -> beginDig(operation);
                case "place-block" -> place(operation);
                case "open-container" -> open(operation);
                case "click-slot" -> click(operation);
                case "close-container" -> close(operation);
                case "select-slot" -> selectSlot(operation);
                case "drop-item" -> drop(operation);
                default -> throw error("UNSUPPORTED","Unknown survival action");
            }
            },()->abort(operation));
            // Retain target-replacement cleanup: an old guarded menu must not remain usable.
            if(operation.status.equals("unknown")&&operation.result instanceof JsonObject result&&result.has("code")&&result.get("code").getAsString().equals("STALE_TARGET")) stop();
        } finally { session.expire(); }
    }
    private void beginDig(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;BlockPos position=block(args);BlockState state=expectedBlock(args,position);
        if(args.has("targetToken")) {
            var resource=resources.require(player,string(args,"targetToken"));
            if(!resource.position().equals(position))throw error("STALE_TARGET","Resource reference position does not match digging target");
            if(state.requiresCorrectToolForDrops()&&!player.getMainHandItem().isCorrectToolForDrops(state))throw error("MISSING_TOOL","Selected hand cannot obtain drops from this resource");
        }
        if(state.isAir()||state.getDestroySpeed(player.serverLevel(),position)<0) throw error("NOT_DIGGABLE","Block cannot be dug");
        BlockHitResult hit=hit(position,null);look(hit.getLocation());guard(operation);
        digging=operation;digPosition=position;digFace=hit.getDirection();digState=state;digSlot=player.getInventory().selected;
        deadline=now()+(long)bounded(args,"timeoutMs",15_000,500,120_000);lastDigTick=Integer.MIN_VALUE;
        nativeEffects.sent();action(ServerboundPlayerActionPacket.Action.START_DESTROY_BLOCK,position,digFace);
        digHand=hand();
        if(!player.serverLevel().getBlockState(position).equals(state)) { completeDig();return; }
        if(!mining().mcbot$isDestroyingBlock()) { nativeEffects.confirmed();abortDig();throw error("FORBIDDEN","Native mining start was refused"); }
        nativeEffects.confirmed(); // START was accepted, but the authoritative block is still unchanged.
    }
    void tick() {
        if(digging==null||lastDigTick==player.getServer().getTickCount()) return;
        lastDigTick=player.getServer().getTickCount();ControlSession.Operation operation=digging;
        try {
            nativeEffects.tick(operation,()-> {
            guard(operation);
            if(operation.args.has("targetToken"))resources.require(player,string(operation.args,"targetToken"));
            if(now()>=deadline) throw error("TIMEOUT","Mining time limit reached");
            if(!player.serverLevel().hasChunkAt(digPosition)||!player.serverLevel().getBlockState(digPosition).equals(digState)) throw error("STALE_BLOCK","Block changed during mining");
            if(player.getInventory().selected!=digSlot||!hand().equals(digHand)) throw error("STALE_ITEM","Main hand changed during mining");
            hit(digPosition,null);
            var progress=mining();
            if(!progress.mcbot$isDestroyingBlock()||progress.mcbot$hasDelayedDestroy()) throw error("FORBIDDEN","Native mining state changed unexpectedly");
            // Native gameMode ticks, not both BodyPlayer callbacks. Never send premature STOP:
            // vanilla would schedule delayed destruction, which ABORT alone does not clear.
            float value=digState.getDestroyProgress(player,player.serverLevel(),digPosition)*(progress.mcbot$gameTicks()-progress.mcbot$destroyProgressStart()+1);
            if(value>=1.0f) {
                guard(operation);nativeEffects.sent();action(ServerboundPlayerActionPacket.Action.STOP_DESTROY_BLOCK,digPosition,digFace);
                if(player.serverLevel().getBlockState(digPosition).equals(digState)) { nativeEffects.confirmed();throw error("FORBIDDEN","Native break was refused; block unchanged"); }
                completeDig();
            } else player.swing(InteractionHand.MAIN_HAND,true);
            },this::abortDig);
        } finally { session.expire(); }
    }
    private void completeDig() {
        ControlSession.Operation operation=digging;
        JsonObject result=obj("block",blockSnapshot(digPosition),"inventory",inventory());
        BlockState actual=player.serverLevel().getBlockState(digPosition);
        boolean removed=actual.isAir()||(!actual.getFluidState().isEmpty()&&actual.getCollisionShape(player.serverLevel(),digPosition).isEmpty());
        abortDig();operation.finish(removed?"succeeded":"unknown",removed?"Native mining removed the authoritative block":"Mining replaced the block with another state; inspect before continuing",result);
    }
    private void abortDig() {
        if(digging==null) return;
        try { action(ServerboundPlayerActionPacket.Action.ABORT_DESTROY_BLOCK,digPosition,digFace); }
        catch(RuntimeException ignored) { /* Lease revocation must still clear local native work. */ }
        finally {
            // A cancelling protection listener must not leave an existing native delayed task.
            mining().mcbot$destroying(false);mining().mcbot$delayed(false);
            player.serverLevel().destroyBlockProgress(player.getId(),digPosition,-1);digging=null;
        }
    }
    private void place(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;BlockPos support=block(args);expectedBlock(args,support);
        Direction face=Direction.byName(string(args,"face"));if(face==null) throw error("INVALID_ARGUMENT","Invalid block face");
        BlockPos target=support.relative(face);
        if(!player.serverLevel().hasChunkAt(target)||!player.serverLevel().getBlockState(target).isAir()) throw error("TARGET_OCCUPIED","Target must be loaded air");
        if(player.serverLevel().getBlockState(support).getMenuProvider(player.serverLevel(),support)!=null) throw error("UNSUPPORTED","Placement against menu blocks is not supported");
        int slot=hotbar(args);ItemStack stack=player.getInventory().getItem(slot);expectedItem(args,"expectedItem","expectedCount","expectedComponents",stack);
        if(!(stack.getItem() instanceof BlockItem item)) throw error("UNSUPPORTED","Only ordinary block items can be placed");
        if(item.getBlock() instanceof DoorBlock||item.getBlock() instanceof BedBlock||item.getBlock() instanceof DoublePlantBlock) throw error("UNSUPPORTED","Multi-block placement requires a separate action contract");
        BlockHitResult hit=hit(support,face);int before=stack.getCount();nativeEffects.sent();select(slot);look(hit.getLocation());guard(operation);
        nativeEffects.sent();player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
        ItemStack after=player.getInventory().getItem(slot);BlockState actual=player.serverLevel().getBlockState(target);
        JsonObject result=obj("block",blockSnapshot(target),"inventory",inventory(),"consumedCount",before-after.getCount());
        boolean remainingMatches=after.isEmpty()?before==1:itemId(after).equals(string(args,"expectedItem"))&&components(after).equals(object(args,"expectedComponents"));
        if(actual.is(item.getBlock())&&after.getCount()==before-1&&remainingMatches) operation.finish("succeeded","Native placement and item consumption confirmed",result);
        else if(actual.isAir()&&after.getCount()==before&&itemId(after).equals(string(args,"expectedItem"))&&components(after).equals(object(args,"expectedComponents"))) operation.finish("failed","FORBIDDEN: Native placement refused without block or inventory change",obj("code","FORBIDDEN","block",blockSnapshot(target),"inventory",inventory()));
        else operation.finish("unknown","Placement produced a different authoritative state; do not replay",result);
    }
    private void open(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;BlockPos position=block(args);BlockState state=expectedBlock(args,position);
        String token=args.has("targetToken")?string(args,"targetToken"):null;
        TargetTokens.Target target=token==null?null:targets.require(player,token);
        if(target!=null&&!target.position().equals(position)) throw error("STALE_TARGET","Token position does not match requested block");
        Block type=state.getBlock();
        if(!NearbyBlocks.ordinaryContainer(state)) throw error("UNSUPPORTED","Only supported storage/furnace blocks may be opened");
        if(state.getMenuProvider(player.serverLevel(),position)==null&&IronFurnaceAdapter.provider(player,position,state)==null) throw error("UNSUPPORTED","Block exposes no supported native menu provider");
        int empty=-1;for(int i=0;i<9;i++) if(player.getInventory().getItem(i).isEmpty()) {empty=i;break;}
        if(empty<0) throw error("EMPTY_HAND_REQUIRED","An empty hotbar slot is needed to avoid item-use fallback");
        BlockHitResult hit=hit(position,null);int previous=player.getInventory().selected;look(hit.getLocation());guard(operation);
        if(token!=null) targets.require(player,token);
        nativeEffects.sent();select(empty);
        try { player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence)); }
        finally { select(previous); }
        if(player.containerMenu==player.inventoryMenu) operation.finish("failed","FORBIDDEN: Native menu interaction refused",obj("code","FORBIDDEN"));
        else if(!standard(player.containerMenu)) { player.connection.handleContainerClose(new ServerboundContainerClosePacket(player.containerMenu.containerId));operation.finish("failed","UNSUPPORTED: Native menu requires an adapter",obj("code","UNSUPPORTED")); }
        else {
            if(token!=null) {
                targets.require(player,token);targets.requireMenu(player,target,player.containerMenu);
                guardedToken=token;guardedTarget=target;guardedMenu=player.containerMenu;
            }
            operation.finish("succeeded","Native container opened",obj("container",container()));
        }
    }
    private void click(ControlSession.Operation operation) {
        JsonObject args=operation.args;AbstractContainerMenu menu=menu(args);int slot=integer(args,"slot"),button=args.has("button")?integer(args,"button"):0;
        if(slot<0||slot>=menu.slots.size()||(button!=0&&button!=1)) throw error("INVALID_ARGUMENT","Invalid slot or button");
        Slot clicked=menu.getSlot(slot);
        if(!slotClickAllowed(clicked.isActive(),clicked.mayPickup(player),clicked.getItem().isEmpty())) throw error("UNSUPPORTED","Inactive slot or protected nonempty slot cannot be clicked by this adapter");
        expectedItem(args,"expectedItem","expectedCount","expectedComponents",menu.getSlot(slot).getItem());
        expectedItem(args,"expectedCarriedItem","expectedCarriedCount","expectedCarriedComponents",menu.getCarried());
        JsonElement before=container().deepCopy();guard(operation);
        verifyGuardedMenu();
        nativeEffects.sent();
        player.connection.handleContainerClick(new ServerboundContainerClickPacket(menu.containerId,menu.getStateId(),slot,button,ClickType.PICKUP,menu.getCarried().copy(),new Int2ObjectOpenHashMap<>()));
        JsonElement after=container();
        if(after.isJsonNull()||player.containerMenu!=menu) operation.finish("unknown","Menu changed while clicking; inspect current state",obj("container",after));
        else if(before.getAsJsonObject().get("slots").equals(after.getAsJsonObject().get("slots"))&&before.getAsJsonObject().get("carried").equals(after.getAsJsonObject().get("carried"))) operation.finish("failed","FORBIDDEN: Native click produced no slot/carried change",obj("code","FORBIDDEN","container",after));
        else operation.finish("succeeded","Native slot/carried change confirmed",obj("container",after,"inventory",inventory()));
    }
    static boolean slotClickAllowed(boolean active,boolean mayPickup,boolean empty) {
        // An empty SlotItemHandler cannot extract anything and reports mayPickup=false.
        // This does not forbid depositing carried items; native PICKUP still checks mayPlace.
        return active&&(empty||mayPickup);
    }
    private void close(ControlSession.Operation operation) {
        AbstractContainerMenu menu=menu(operation.args);guard(operation);verifyGuardedMenu();nativeEffects.sent();player.connection.handleContainerClose(new ServerboundContainerClosePacket(menu.containerId));
        operation.finish(player.containerMenu==player.inventoryMenu?"succeeded":"unknown","Native container close observed",obj("container",container(),"inventory",inventory()));
    }
    private void selectSlot(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;int slot=hotbar(args);expectedItem(args,"expectedItem","expectedCount","expectedComponents",player.getInventory().getItem(slot));guard(operation);
        nativeEffects.sent();select(slot);operation.finish(player.getInventory().selected==slot?"succeeded":"unknown","Native selected hotbar slot observed",obj("selectedSlot",player.getInventory().selected,"stack",hand()));
    }
    private Set<Integer> droppedEntities() {
        Set<Integer> ids=new HashSet<>();for(ItemEntity entity:player.serverLevel().getEntitiesOfClass(ItemEntity.class,player.getBoundingBox().inflate(8))) ids.add(entity.getId());return ids;
    }
    private void drop(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;int slot=hotbar(args),count=integer(args,"count");
        if(slot!=player.getInventory().selected) throw error("STALE_ITEM","Select this slot explicitly before dropping");
        ItemStack initial=player.getInventory().getItem(slot);expectedItem(args,"expectedItem","expectedCount","expectedComponents",initial);
        if(count<1||count>64||count>initial.getCount()) throw error("INVALID_ARGUMENT","count must be 1..64 within selected stack");
        int original=initial.getCount(),dropped=0,removed=0;String itemId=itemId(initial);JsonObject expected=components(initial);
        try {
            for(int i=0;i<count;i++) {
                guard(operation);ItemStack current=player.getInventory().getItem(slot);
                recipient(args);
                if(player.getInventory().selected!=slot||!itemId(current).equals(itemId)||current.getCount()!=original-removed||!components(current).equals(expected)) throw error("STALE_ITEM","Remaining selected stack changed during drop");
                if(args.has("expectedMaxStackSize")&&integer(args,"expectedMaxStackSize")!=current.getMaxStackSize())throw error("STALE_ITEM","Effective stack maximum changed during native drop");
                Set<Integer> previous=droppedEntities();int before=current.getCount();nativeEffects.sent();
                action(ServerboundPlayerActionPacket.Action.DROP_ITEM,BlockPos.ZERO,Direction.DOWN);
                ItemStack after=player.getInventory().getItem(slot);int delta=before-after.getCount();removed+=delta;
                int delivered=0;for(ItemEntity entity:player.serverLevel().getEntitiesOfClass(ItemEntity.class,player.getBoundingBox().inflate(8))) if(!previous.contains(entity.getId())&&itemId(entity.getItem()).equals(itemId)&&components(entity.getItem()).equals(expected)) delivered+=entity.getItem().getCount();
                dropped+=delivered;
                nativeEffects.confirmed(); // This unit's inventory delta and matching entities are both known.
                if(delta!=1||delivered!=1) { operation.finish(delta==0&&delivered==0?"failed":"unknown","Native drop refused or produced unexpected effects",obj("code","DROP_PARTIAL","droppedCount",dropped,"removedCount",removed,"requestedCount",count));return; }
            }
            operation.finish("succeeded","Native dropped item entities and inventory consumption confirmed",obj("droppedCount",dropped,"removedCount",removed,"requestedCount",count));
        } finally {
            // Preserve known partial effects even if lease expiry already cancelled this operation.
            NativeActionBoundary.recordDropProgress(operation,dropped,removed,count);
        }
    }
    private void recipient(JsonObject args) {
        if(!args.has("recipient")&&!args.has("expectedEntityId")) return;
        String name=string(args,"recipient"),expected=string(args,"expectedEntityId");
        ServerPlayer target=player.getServer().getPlayerList().getPlayerByName(name);
        if(target==null||target==player||!target.isAlive()||target.serverLevel()!=player.serverLevel()||!target.getUUID().toString().equals(expected)||target.distanceToSqr(player)>1.5*1.5||!NearbyBlocks.visiblePlayer(player,target))
            throw error("STALE_TARGET","Recipient changed, left 1.5-block reach or is not visible");
    }
    void stop() {
        try { abortDig(); } finally {
            try {
                player.stopUsingItem();
                if(player.containerMenu!=player.inventoryMenu) player.connection.handleContainerClose(new ServerboundContainerClosePacket(player.containerMenu.containerId));
            } catch(RuntimeException ignored) { /* Native menu callbacks cannot prevent lease invalidation. */ }
            finally { knownMenu=null;knownMenuState=null;guardedToken=null;guardedTarget=null;guardedMenu=null; }
        }
    }
    void abort(ControlSession.Operation operation) { if(digging==operation) abortDig(); }
}
