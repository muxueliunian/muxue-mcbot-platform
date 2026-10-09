package com.mcbot.servercontrol;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mcbot.servercontrol.platform.ItemSlots;
import com.mcbot.servercontrol.platform.LoaderPlatform;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * machine-items (8b): list, insert into or extract from a mod machine through its item handler, without opening a
 * menu. Only blocks of mods the server owner enabled ({@link GenericItemSlots}) and without a dedicated adapter; the
 * body must see the block within ordinary reach, and the server must let it right-click there (spawn protection,
 * protection mods). Insert takes plain stacks from the main inventory; extract fills the main inventory only.
 */
final class MachineItems {
    private MachineItems() {}
    static final int MAX_COUNT=36*64;
    static final GenericItemSlots.Stacks<ItemStack> STACKS=new GenericItemSlots.Stacks<>() {
        public boolean empty(ItemStack s){return s.isEmpty();}
        public int count(ItemStack s){return s.getCount();}
        public ItemStack copy(ItemStack s,int n){return s.copyWithCount(n);}
        public boolean same(ItemStack a,ItemStack b){return ItemStack.isSameItemSameComponents(a,b);}
    };
    static GenericItemSlots.Slots<ItemStack> slots(ItemSlots handler) {
        return new GenericItemSlots.Slots<>() {
            public int size(){return handler.size();}
            public ItemStack get(int slot){return handler.get(slot);}
            public int limit(int slot){return handler.limit(slot);}
            public boolean valid(int slot,ItemStack stack){return handler.valid(slot,stack);}
            public ItemStack insert(int slot,ItemStack stack,boolean simulate){return handler.insert(slot,stack,simulate);}
            public ItemStack extract(int slot,int amount,boolean simulate){return handler.extract(slot,amount,simulate);}
        };
    }

    static void run(ControlSession.Operation operation,ServerPlayer player) {
        JsonObject args=operation.args;
        String mode=string(args,"mode");
        if(!Set.of("list","insert","extract").contains(mode)) throw error("INVALID_ARGUMENT","mode must be list, insert or extract");
        String side=GenericItemSlots.side(args.has("side")&&!args.get("side").isJsonNull()?string(args,"side"):null);
        int slot=args.has("slot")?bounded(args,"slot",0,GenericItemSlots.MAX_SLOTS-1):-1;
        BlockPos position=new BlockPos(bounded(args,"x",-29_999_000,29_999_000),bounded(args,"y",-2048,2048),bounded(args,"z",-29_999_000,29_999_000));
        var level=player.serverLevel();
        if(!level.hasChunkAt(position)) throw error("UNLOADED","Target chunk is not loaded");
        BlockState state=level.getBlockState(position);
        String blockId=BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if(args.has("expectedBlock")&&!string(args,"expectedBlock").equals(blockId)) throw error("STALE_BLOCK","Block changed: now "+blockId);
        String refusal=ModAdapters.itemHandlerRefusal(state);
        if(refusal!=null) throw error("UNSUPPORTED",refusal);
        BlockHitResult hit=reach(player,position,state);
        // Asked before anything is read: a protected machine is neither looked into nor touched.
        if(!LoaderPlatform.get().mayUseBlock(player,hit)) throw error("FORBIDDEN","The server does not let the body use this block (spawn protection or a protection mod)");
        BlockEntity entity=level.getBlockEntity(position);
        ItemSlots handler=lookup(player,position,state,entity,side);
        JsonObject block=obj("position",NativeWorkstation.pos(position),"id",blockId);
        if(handler==null) throw error("UNSUPPORTED","No item handler on "+(side==null?"the unsided view":"side "+side)+"; sides offered: "+sides(player,position,state,entity));
        var view=slots(handler);
        JsonObject result=obj("block",block,"side",side);
        switch(mode) {
            case "list" -> {
                result.add("sides",sides(player,position,state,entity));
                result.add("slots",contents(view));
                int size=GenericItemSlots.size(view);result.addProperty("size",size);
                if(size>GenericItemSlots.MAX_SLOTS) result.addProperty("truncated",true);
                operation.finish("succeeded","Machine contents read through its item handler (no menu)",result);
            }
            case "insert" -> insert(operation,player,view,slot,result);
            default -> extract(operation,player,view,slot,result);
        }
    }

    private static void insert(ControlSession.Operation operation,ServerPlayer player,GenericItemSlots.Slots<ItemStack> view,int slot,JsonObject result) {
        JsonObject args=operation.args;
        Item item=NativeWorkstation.item(string(args,"item"));int wanted=bounded(args,"count",1,MAX_COUNT);
        Inventory inventory=player.getInventory();
        ItemStack template=ItemStack.EMPTY;int have=0;
        for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(NativeWorkstation.plain(s)&&s.is(item)){if(template.isEmpty())template=s.copyWithCount(1);have+=s.getCount();}}
        if(have==0) throw error("MISSING_ITEM","No plain "+NativeWorkstation.id(item)+" in the main inventory");
        int requested=Math.min(wanted,have);
        final ItemStack kind=template;
        GenericItemSlots.Pocket<ItemStack> pocket=new GenericItemSlots.Pocket<>() {
            public void take(int count) {
                for(int i=0;i<36&&count>0;i++){ItemStack s=inventory.getItem(i);if(NativeWorkstation.plain(s)&&ItemStack.isSameItemSameComponents(s,kind)){int n=Math.min(count,s.getCount());s.shrink(n);count-=n;}}
                inventory.setChanged();
            }
            public void giveBack(ItemStack rest) { ItemStack left=put(inventory,rest);if(!left.isEmpty())player.drop(left,false); }
        };
        var moved=GenericItemSlots.insert(view,STACKS,kind,requested,slot,pocket);
        result.addProperty("item",NativeWorkstation.id(item));result.addProperty("requested",wanted);result.addProperty("inInventory",have);
        finish(operation,moved,wanted,true,result,view);
    }

    private static void extract(ControlSession.Operation operation,ServerPlayer player,GenericItemSlots.Slots<ItemStack> view,int slot,JsonObject result) {
        JsonObject args=operation.args;
        if(!args.has("item")&&slot<0) throw error("INVALID_ARGUMENT","extract needs an item, a slot, or both");
        Item item=args.has("item")?NativeWorkstation.item(string(args,"item")):null;
        boolean counted=args.has("count");int wanted=counted?bounded(args,"count",1,MAX_COUNT):MAX_COUNT;
        Inventory inventory=player.getInventory();
        GenericItemSlots.Room<ItemStack> room=new GenericItemSlots.Room<>() {
            public int room(ItemStack stack){return MachineItems.room(inventory,stack);}
            public ItemStack put(ItemStack stack){return MachineItems.put(inventory,stack);}
            public void spill(ItemStack stack){player.drop(stack.copy(),false);}
        };
        var moved=GenericItemSlots.extract(view,STACKS,s->item==null||s.is(item),wanted,slot,room);
        if(item!=null)result.addProperty("item",NativeWorkstation.id(item));
        if(counted)result.addProperty("requested",wanted);
        // Without a count, "all of it": stopping early (inventory full, handler fault) is still only part of it.
        finish(operation,moved,counted?wanted:moved.count>0&&moved.fault==null?moved.count:moved.count+1,false,result,view);
    }

    /** Status from what really moved: all requested = succeeded; some = PARTIAL; none = failed; a faulty real call = unknown. */
    private static void finish(ControlSession.Operation operation,GenericItemSlots.Moved moved,int wanted,boolean insert,JsonObject result,GenericItemSlots.Slots<ItemStack> view) {
        result.addProperty("moved",moved.count);
        JsonArray steps=new JsonArray();for(var step:moved.steps)steps.add(obj("slot",step.slot(),"count",step.count()));result.add("slots",steps);
        if(moved.invalidSlots>0)result.addProperty("refusedByIsItemValid",moved.invalidSlots);
        if(moved.uncertain>0)result.addProperty("uncertain",moved.uncertain);
        if(moved.withheld>0)result.addProperty("withheld",moved.withheld);
        if(moved.fault!=null)result.addProperty("detail",moved.fault);
        try { result.add("after",contents(view)); } catch(Protocol.Error unreadable) { /* the receipt still holds what moved */ }
        String verb=insert?"Inserted ":"Extracted ";
        if(moved.unknown) { result.addProperty("code","NATIVE_UNKNOWN");operation.finish("unknown","Item handler misbehaved during a real move; observe the machine and inventory, never blindly replay",result); }
        else if(moved.count>=wanted) operation.finish("succeeded",verb+moved.count+" through the item handler",result);
        else if(moved.count>0) { result.addProperty("code","PARTIAL");operation.finish("failed",verb+"only "+moved.count+" of "+wanted+(moved.fault==null?"":" ("+moved.fault+")"),result); }
        else {
            String code=insert?"NOT_ACCEPTED":"Inventory is full".equals(moved.fault)?"NO_ROOM":"NOTHING_TO_TAKE";
            result.addProperty("code",code);
            operation.finish("failed",code+": "+(insert?(moved.invalidSlots>0?"isItemValid refused it in "+moved.invalidSlots+" slot(s) and no other slot took it":"No slot took it")
                :moved.fault!=null?moved.fault
                :moved.withheld>0?"The machine holds "+moved.withheld+" matching but this side does not give them out; list other sides, or the machine may release only finished items"
                :"No matching item could be extracted"),result);
        }
    }

    private static JsonArray contents(GenericItemSlots.Slots<ItemStack> view) {
        JsonArray slots=new JsonArray();
        for(var content:GenericItemSlots.contents(view,STACKS)) {
            JsonObject entry=content.stack()==null?obj("slot",content.slot(),"item",null,"count",0):ItemDescriptions.describe(content.stack());
            entry.addProperty("slot",content.slot());entry.addProperty("limit",content.limit());slots.add(entry);
        }
        return slots;
    }
    private static JsonArray sides(ServerPlayer player,BlockPos position,BlockState state,BlockEntity entity) {
        JsonArray result=new JsonArray();
        for(var entry:GenericItemSlots.sides(side->{ItemSlots h=lookup(player,position,state,entity,side);return h==null?null:slots(h);}))
            result.add(obj("side",entry.getKey(),"slots",entry.getValue()));
        return result;
    }
    private static ItemSlots lookup(ServerPlayer player,BlockPos position,BlockState state,BlockEntity entity,String side) {
        try { return LoaderPlatform.get().itemSlots(player.serverLevel(),position,state,entity,side==null?null:Direction.byName(side)); }
        catch(RuntimeException | LinkageError broken) { return null; }
    }
    /** The block in sight and within ordinary reach, as for a right-click; the body turns to it. */
    private static BlockHitResult reach(ServerPlayer player,BlockPos position,BlockState state) {
        var level=player.serverLevel();
        if(!level.getWorldBorder().isWithinBounds(position)) throw error("FORBIDDEN","Target outside world border");
        var shape=state.getShape(level,position);
        Vec3 aim=shape.isEmpty()?Vec3.atCenterOf(position):shape.bounds().move(position).getCenter();
        BlockHitResult hit=level.clip(new ClipContext(player.getEyePosition(),aim,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        if(hit.getType()!=HitResult.Type.BLOCK||!hit.getBlockPos().equals(position)) throw error("NO_LINE_OF_SIGHT","Machine is obstructed");
        if(player.getEyePosition().distanceTo(hit.getLocation())>player.blockInteractionRange()) throw error("OUT_OF_REACH","Machine is out of reach; walk closer first");
        NativeWorkstation.look(player,hit.getLocation());
        return hit;
    }
    private static int bounded(JsonObject args,String key,int min,int max) {
        double value=number(args,key);
        if(value!=Math.rint(value)||value<min||value>max) throw error("INVALID_ARGUMENT",key+" must be an integer "+min+".."+max);
        return (int)value;
    }
    /** How many more of this exact stack the main inventory (slots 0..35) can hold. */
    static int room(Inventory inventory,ItemStack stack) {
        int max=Math.min(stack.getMaxStackSize(),inventory.getMaxStackSize()),room=0;
        for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(s.isEmpty())room+=max;else if(ItemStack.isSameItemSameComponents(s,stack))room+=Math.max(0,max-s.getCount());}
        return room;
    }
    /** Stores a stack in the main inventory, topping up matching stacks first; returns what did not fit. */
    static ItemStack put(Inventory inventory,ItemStack stack) {
        ItemStack rest=stack.copy();int max=Math.min(rest.getMaxStackSize(),inventory.getMaxStackSize());
        for(int i=0;i<36&&!rest.isEmpty();i++){ItemStack s=inventory.getItem(i);if(!s.isEmpty()&&ItemStack.isSameItemSameComponents(s,rest)&&s.getCount()<max){int n=Math.min(rest.getCount(),max-s.getCount());s.grow(n);rest.shrink(n);}}
        for(int i=0;i<36&&!rest.isEmpty();i++){if(inventory.getItem(i).isEmpty()){int n=Math.min(rest.getCount(),max);inventory.setItem(i,rest.copyWithCount(n));rest.shrink(n);}}
        inventory.setChanged();
        return rest;
    }
}
