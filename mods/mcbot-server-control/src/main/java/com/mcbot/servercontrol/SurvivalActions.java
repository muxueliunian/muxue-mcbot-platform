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
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.damagesource.DamageTypes;
import net.neoforged.neoforge.event.entity.living.LivingDamageEvent;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.neoforge.event.entity.player.AttackEntityEvent;
import net.neoforged.neoforge.event.entity.player.SweepAttackEvent;
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
    private static final Map<ServerPlayer,NativeDefenseUse> NATIVE_ATTACKS=new IdentityHashMap<>();
    static final List<String> CAPABILITIES=List.of("dig-block","place-block","open-container","click-slot","close-container","select-slot","drop-item","swap-inventory","eat-item","defend-entity");
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
    private NativeFoodUse eating;
    private int lastEatTick=Integer.MIN_VALUE;
    private NativeDefenseUse defense;
    private int lastDefenseTick=Integer.MIN_VALUE;
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
    JsonObject observedStack(int slot,ItemStack stack) {
        JsonObject value=StackObservation.value(itemId(stack),stack.getCount(),()->stackValue(stack));value.addProperty("slot",slot);return value;
    }
    JsonArray observedInventory() {
        JsonArray result=new JsonArray();for(int i=0;i<player.getInventory().getContainerSize();i++)result.add(observedStack(i,player.getInventory().getItem(i)));return result;
    }
    JsonObject survivalState(JsonObject params) {
        boolean details=!params.has("details")||bool(params,"details");
        JsonArray foods=new JsonArray();
        for(int slot=0;slot<36;slot++) {
            ItemStack stack=player.getInventory().getItem(slot);if(stack.isEmpty())continue;
            JsonObject food=FoodSafety.candidate(slot,stack,player);if(food!=null)foods.add(food);
        }
        JsonObject result=obj("dimension",player.serverLevel().dimension().location().toString(),"serverTick",player.getServer().getTickCount(),"observedAt",System.currentTimeMillis(),
            "connected",true,"username",player.getGameProfile().getName(),"source","server-observed","health",player.getHealth(),"maxHealth",player.getMaxHealth(),
            "food",player.getFoodData().getFoodLevel(),"saturation",player.getFoodData().getSaturationLevel(),"selectedSlot",player.getInventory().selected,
            "usingItem",player.isUsingItem(),"foods",foods);
        JsonObject dangers=ThreatSense.dangers(player),threats=ThreatSense.nearby(player);
        for(JsonElement entry:threats.getAsJsonArray("nearby")) {
            JsonObject threat=entry.getAsJsonObject();if(threat.has("explosionPreparing")&&!threat.get("explosionPreparing").isJsonNull()&&threat.get("explosionPreparing").getAsBoolean()&&threat.get("defenseEligible").getAsBoolean())dangers.addProperty("retreatRecommended",true);
        }
        result.add("dangers",dangers);result.add("threats",threats);
        if(details)result.add("inventory",observedInventory());return result;
    }
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
                case "swap-inventory" -> swapInventory(operation);
                case "eat-item" -> eat(operation);
                case "defend-entity" -> defend(operation);
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
            if(!player.hasCorrectToolForDrops(state,player.serverLevel(),position))throw error("MISSING_TOOL","Native position-sensitive harvest check refused resource drops for the selected hand");
            requireOrdinaryOreTool(state,position);
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
        if(defense!=null&&lastDefenseTick!=player.getServer().getTickCount()) {
            lastDefenseTick=player.getServer().getTickCount();NativeDefenseUse current=defense;current.tick();
            if(defense==current&&!current.alive())defense=null;
        }
        if(eating!=null&&lastEatTick!=player.getServer().getTickCount()) {
            lastEatTick=player.getServer().getTickCount();NativeFoodUse current=eating;current.tick();
            if(eating==current&&!current.alive())eating=null;
        }
        if(digging==null||lastDigTick==player.getServer().getTickCount()) return;
        lastDigTick=player.getServer().getTickCount();ControlSession.Operation operation=digging;
        try {
            nativeEffects.tick(operation,()-> {
            guard(operation);
            if(operation.args.has("targetToken"))resources.require(player,string(operation.args,"targetToken"));
            if(now()>=deadline) throw error("TIMEOUT","Mining time limit reached");
            if(!player.serverLevel().hasChunkAt(digPosition)||!player.serverLevel().getBlockState(digPosition).equals(digState)) throw error("STALE_BLOCK","Block changed during mining");
            if(player.getInventory().selected!=digSlot||!hand().equals(digHand)) throw error("STALE_ITEM","Main hand changed during mining");
            if(operation.args.has("targetToken")) {
                if(!player.hasCorrectToolForDrops(digState,player.serverLevel(),digPosition))throw error("MISSING_TOOL","Native resource harvest eligibility changed during mining");
                requireOrdinaryOreTool(digState,digPosition);
            }
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
    private void requireOrdinaryOreTool(BlockState state,BlockPos position) {
        String id=BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if(!ResourceCatalog.ore(id))return;
        var view=ToolAssessment.snapshot(player.getInventory().selected,player.getMainHandItem(),player.registryAccess());
        ResourceCatalog.requireOrdinaryOreTool(id,ToolAssessment.candidate(view,state,state.getDestroySpeed(player.serverLevel(),position)));
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
    private void expectedStack(JsonObject expected,ItemStack stack) {
        if(expected.has("componentsComplete")&&!bool(expected,"componentsComplete"))throw error("INCOMPLETE_GUARD","Expected stack components are incomplete");
        if(!string(expected,"id").equals(itemId(stack))||integer(expected,"count")!=stack.getCount()||!object(expected,"components").equals(components(stack)))throw error("STALE_ITEM","Inventory stack ID, count or components changed");
        if(expected.has("maxStackSize")&&(stack.isEmpty()||integer(expected,"maxStackSize")!=stack.getMaxStackSize()))throw error("STALE_ITEM","Inventory stack maximum changed");
    }
    private void swapInventory(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;int source=integer(args,"sourceSlot"),target=integer(args,"hotbarSlot");
        if(source<0||source>35||target<0||target>8||source==target)throw error("INVALID_ARGUMENT","Swap requires distinct main inventory 0..35 and hotbar 0..8 slots");
        AbstractContainerMenu menu=player.inventoryMenu;
        if(!menu.getCarried().isEmpty()||!menu.stillValid(player))throw error("BUSY","Inventory swap requires an empty cursor and valid own inventory menu");
        var backing=menu.slots.stream().map(slot->new MenuSlotSources.BackingSlot(slot.container,slot.getContainerSlot(),slot.container.getContainerSize())).toList();
        int sourceMenu=InventorySwap.menuSlot(backing,player.getInventory(),source),targetMenu=InventorySwap.menuSlot(backing,player.getInventory(),target);
        Slot sourceSlot=menu.getSlot(sourceMenu),targetSlot=menu.getSlot(targetMenu);
        ItemStack sourceStack=player.getInventory().getItem(source),targetStack=player.getInventory().getItem(target);
        expectedStack(object(args,"expectedSource"),sourceStack);expectedStack(object(args,"expectedTarget"),targetStack);
        if(!sourceSlot.isActive()||!targetSlot.isActive()||(!sourceStack.isEmpty()&&(!sourceSlot.mayPickup(player)||!targetSlot.mayPlace(sourceStack)||sourceStack.getCount()>targetSlot.getMaxStackSize(sourceStack)))
            ||(!targetStack.isEmpty()&&(!targetSlot.mayPickup(player)||!sourceSlot.mayPlace(targetStack)||targetStack.getCount()>sourceSlot.getMaxStackSize(targetStack))))throw error("UNSUPPORTED","Native slot eligibility or capacity does not permit a complete swap");
        JsonArray before=observedInventory();guard(operation);
        if(player.containerMenu!=menu||!menu.getCarried().isEmpty())throw error("STALE_CONTAINER","Own inventory menu or cursor changed before swap");
        nativeEffects.sent();
        player.connection.handleContainerClick(new ServerboundContainerClickPacket(menu.containerId,menu.getStateId(),sourceMenu,target,ClickType.SWAP,menu.getCarried().copy(),new Int2ObjectOpenHashMap<>()));
        // Relevant stacks must still encode completely; unrelated inventory entries may carry explicit read-only degradation.
        stackValue(player.getInventory().getItem(source));stackValue(player.getInventory().getItem(target));
        JsonArray after=observedInventory();JsonObject result=obj("sourceSlot",source,"hotbarSlot",target,"inventory",after);
        if(player.containerMenu!=menu||!menu.getCarried().isEmpty())operation.finish("unknown","Inventory menu or cursor changed during native swap; do not repeat",result);
        else if(InventorySwap.exact(before,after,source,target))operation.finish("succeeded","Native inventory SWAP and complete source/target receipts confirmed",result);
        else if(before.equals(after))operation.finish("failed","Native swap produced no inventory change",obj("code","FORBIDDEN","sourceSlot",source,"hotbarSlot",target,"inventory",after));
        else operation.finish("unknown","Native swap produced other inventory effects; do not repeat",result);
    }
    private void eat(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;int slot=hotbar(args);ItemStack stack=player.getInventory().getItem(slot);
        if(!player.inventoryMenu.getCarried().isEmpty())throw error("BUSY","Food use requires an empty own inventory cursor");
        expectedItem(args,"expectedItem","expectedCount","expectedComponents",stack);
        FoodSafety.Profile profile=FoodSafety.assess(stack,player);
        if(!profile.safe())throw error("UNSUPPORTED","Food has unverified or protected consumption semantics: "+profile.reason());
        if(!player.canEat(false))throw error("FORBIDDEN","Body is not hungry; no native food use was sent");
        JsonObject before=stackValue(stack),returned=profile.food().usingConvertsTo().map(this::stackValue).orElse(null);
        long eatDeadline=now()+(long)bounded(args,"timeoutMs",Math.max(15_000,profile.food().eatDurationTicks()*50L+2_000),500,120_000);
        NativeFoodUse use=new NativeFoodUse(operation,new NativeFoodUse.View() {
            public void guard(){SurvivalActions.this.guard(operation);}
            public int slot(){return player.getInventory().selected;}
            public boolean using(){return player.isUsingItem();}
            public boolean mainHand(){return player.getUsedItemHand()==InteractionHand.MAIN_HAND;}
            public JsonObject hand(){return stackValue(player.getMainHandItem());}
            public JsonArray inventory(){return observedInventory();}
            public int food(){return player.getFoodData().getFoodLevel();}
            public float saturation(){return player.getFoodData().getSaturationLevel();}
            public void stopUsing(){stopNativeFoodUse();}
        },nativeEffects,SurvivalActions::now,eatDeadline,slot,before,returned);
        eating=use;lastEatTick=Integer.MIN_VALUE;guard(operation);nativeEffects.sent();select(slot);
        if(player.getInventory().selected!=slot||!before.equals(stackValue(player.getMainHandItem())))throw error("STALE_ITEM","Native selected hand differs from guarded food");
        player.connection.handleUseItem(new ServerboundUseItemPacket(InteractionHand.MAIN_HAND,++sequence,player.getYRot(),player.getXRot()));
        use.tick();if(!use.alive())eating=null;
    }
    void receiveFoodFinish(boolean mainHand,ItemStack original,ItemStack result) {
        NativeFoodUse use=eating;if(use==null||!use.alive())return;
        nativeEffects.tick(use.operation,()->use.finished(mainHand,player.getInventory().selected,stackValue(original),stackValue(result)),()->abortEat(use.operation));
    }
    private void defend(ControlSession.Operation operation) {
        worldAction();JsonObject args=operation.args;int slot=hotbar(args);
        if(slot!=player.getInventory().selected)throw error("STALE_ITEM","Select and prepare the defense hand explicitly first");
        if(!player.inventoryMenu.getCarried().isEmpty())throw error("BUSY","Defense requires an empty own inventory cursor");
        ItemStack stack=player.getMainHandItem();expectedItem(args,"expectedItem","expectedCount","expectedComponents",stack);
        String entityId=string(args,"entityId"),dimension=string(args,"expectedDimension");
        LivingEntity target=ThreatSense.lookup(player,entityId,dimension);ThreatSense.requireEligible(player,target);
        if(!target.isAlive())throw error("STALE_TARGET","Threat is no longer alive");
        double distance=bounded(args,"maxDistance",3,1,3),minHealth=bounded(args,"minHealth",8,1,20);
        double attacksValue=bounded(args,"maxAttacks",2,1,3);
        if(attacksValue!=Math.rint(attacksValue))throw error("INVALID_ARGUMENT","maxAttacks must be an integer");
        int maximum=(int)attacksValue;DefenseWeaponSafety.require(stack,maximum);
        long defenseDeadline=now()+(long)bounded(args,"timeoutMs",3000,500,5000);
        JsonObject[] expected={stackValue(stack)};
        NativeDefenseUse use=new NativeDefenseUse(operation,new NativeDefenseUse.View() {
            public void guard(){
                SurvivalActions.this.guard(operation);worldAction();
                if(!player.serverLevel().dimension().location().toString().equals(dimension))throw error("WORLD_CHANGED","Defense dimension changed");
                if(player.getInventory().selected!=slot||!expected[0].equals(stackValue(player.getMainHandItem())))throw error("STALE_ITEM","Defense hand changed");
                if(!player.inventoryMenu.getCarried().isEmpty())throw error("BUSY","Defense cursor is no longer empty");
                DefenseWeaponSafety.require(player.getMainHandItem(),maximum);
            }
            public String termination(){
                if(!target.isAlive())return "target_dead";
                if(target.isRemoved()||player.serverLevel().getEntity(target.getUUID())!=target)return "target_left";
                ThreatSense.requireEligible(player,target);
                if(ThreatSense.retreatRequired(player,target,minHealth)||player.isInLava())throw error("RETREAT_REQUIRED","Low health or preparing explosion requires a separately bounded safe retreat");
                if(player.distanceToSqr(target)>distance*distance||!player.canInteractWithEntity(target,0))return "target_left";
                if(!player.hasLineOfSight(target))return "lost_line_of_sight";
                // Native sweep hooks can enable sweeping even for an axe. Verify the native item-extension envelope first.
                AABB sweep=player.getMainHandItem().getSweepHitBox(player,target);
                if(!sweep.equals(target.getBoundingBox().inflate(1,0.25,1)))throw error("UNSUPPORTED","UNVERIFIED_SWEEP_ENVELOPE");
                double reach=player.entityInteractionRange();
                if(!Double.isFinite(reach)||reach<=0)throw error("UNSUPPORTED","UNVERIFIED_NATIVE_ENTITY_REACH");
                for(LivingEntity other:player.serverLevel().getEntitiesOfClass(LivingEntity.class,sweep))
                    if(other!=player&&other!=target&&other.isAlive()&&player.distanceToSqr(other)<reach*reach)throw error("COLLATERAL_RISK","Another living entity is inside the native sweep envelope");
                return null;
            }
            public boolean cooledDown(){return player.getAttackStrengthScale(0.5f)>=1f;}
            public boolean targetAlive(){return target.isAlive();}
            public void attack(){
                NativeDefenseUse scope=defense;
                if(scope==null||scope.operation!=operation)throw error("LEASE_LOST","Defense intent changed before native call");
                NATIVE_ATTACKS.put(player,scope);
                try {
                look(target.getEyePosition());player.attack(target);
                scope.requireNativeAuthorized();
                // A synchronous native callback may cancel or revoke control. Do not emit a late swing after it.
                if(!session.mayDrive(operation))throw error("LEASE_LOST","Control changed inside native attack");
                player.swing(InteractionHand.MAIN_HAND,true);
                JsonObject after=stackValue(player.getMainHandItem()),before=expected[0].deepCopy(),comparable=after.deepCopy();
                before.getAsJsonObject("components").remove("minecraft:damage");comparable.getAsJsonObject("components").remove("minecraft:damage");
                if(!before.equals(comparable))throw error("DEFENSE_EFFECT_UNKNOWN","Native attack changed unexpected selected item fields");
                expected[0]=after;
                } finally {NATIVE_ATTACKS.remove(player,scope);}
            }
        },nativeEffects,SurvivalActions::now,defenseDeadline,maximum,entityId);
        // Initial eligibility failures precede any native attack. Every subsequent tick repeats these checks.
        defense=use;lastDefenseTick=player.getServer().getTickCount();use.tick();if(!use.alive())defense=null;
    }
    void receiveDamage(LivingDamageEvent.Post event) {
        NativeDefenseUse use=NATIVE_ATTACKS.get(player);
        if(use!=null&&event.getSource().getDirectEntity()==player&&event.getSource().getEntity()==player&&event.getSource().is(DamageTypes.PLAYER_ATTACK))
            use.receipt(event.getEntity().getUUID().toString(),event.getNewDamage());
    }
    static boolean nativeWriteInProgress(ServerPlayer player) {return player!=null&&NATIVE_ATTACKS.containsKey(player);}
    static void guardNativeAttack(AttackEntityEvent event) {
        NativeDefenseUse scope=NATIVE_ATTACKS.get(event.getEntity());
        if(scope!=null&&!scope.allowNativeTarget(event.getTarget().getUUID().toString()))event.setCanceled(true);
    }
    static void guardNativeIncomingDamage(LivingIncomingDamageEvent event) {
        NativeDefenseUse scope=NATIVE_ATTACKS.get(event.getSource().getDirectEntity());
        if(scope==null)return;
        boolean authorized=event.getSource().getEntity()==event.getSource().getDirectEntity()&&event.getSource().is(DamageTypes.PLAYER_ATTACK);
        if(!authorized)scope.refuseNative(error("DEFENSE_EFFECT_UNKNOWN","Unexpected native damage source inside defense"));
        if(!authorized||!scope.allowNativeTarget(event.getEntity().getUUID().toString()))event.setCanceled(true);
    }
    static void guardNativeSweep(SweepAttackEvent event) {
        if(!NATIVE_ATTACKS.containsKey(event.getEntity()))return;
        // Native single-target defense never authorizes an area attack, including Mod-forced axe sweeps.
        event.setSweeping(false);event.setCanceled(true);
    }
    private void stopNativeFoodUse() {
        try { if(player.isUsingItem())action(ServerboundPlayerActionPacket.Action.RELEASE_USE_ITEM,BlockPos.ZERO,Direction.DOWN); }
        finally {player.stopUsingItem();}
    }
    private void abortEat(ControlSession.Operation operation) {
        NativeFoodUse use=eating;if(use==null||use.operation!=operation)return;eating=null;use.stop();
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
        try {if(defense!=null){defense.stop();defense=null;}if(eating!=null)abortEat(eating.operation);abortDig();} finally {
            try {
                player.stopUsingItem();
                if(player.containerMenu!=player.inventoryMenu) player.connection.handleContainerClose(new ServerboundContainerClosePacket(player.containerMenu.containerId));
            } catch(RuntimeException ignored) { /* Native menu callbacks cannot prevent lease invalidation. */ }
            finally { knownMenu=null;knownMenuState=null;guardedToken=null;guardedTarget=null;guardedMenu=null; }
        }
    }
    void abort(ControlSession.Operation operation) {if(defense!=null&&defense.operation==operation){defense.stop();defense=null;}if(eating!=null&&eating.operation==operation)abortEat(operation);if(digging==operation) abortDig();}
}
