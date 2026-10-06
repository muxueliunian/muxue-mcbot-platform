package com.mcbot.servercontrol;

import com.mcbot.servercontrol.api.ContainerAdapter;
import com.mcbot.servercontrol.api.McbotApi;
import java.util.*;
import net.neoforged.neoforge.items.SlotItemHandler;
import net.neoforged.neoforge.items.wrapper.InvWrapper;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.MenuProvider;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.*;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/** Version-pinned optional adapter; no compile-time dependency on Iron Furnaces. */
final class IronFurnaceAdapter {
    static final String VERSION="4.3.2",ID="ironfurnaces:iron_furnace";
    static final String BLOCK="ironfurnaces.blocks.furnaces.BlockIronFurnace";
    static final String ENTITY="ironfurnaces.tileentity.furnaces.BlockIronFurnaceTile";
    static final String MENU="ironfurnaces.container.furnaces.BlockIronFurnaceContainer";
    static final int MACHINE_SLOTS=19,TOTAL_SLOTS=55;
    record NativeSlot(Object backing,int index,int size,String className,Object wrappedInventory) {}
    private static final List<String> SLOT_CLASSES=List.of("SlotIronFurnaceInput","SlotIronFurnaceFuel","SlotIronFurnace",
        "SlotIronFurnaceAugmentRed","SlotIronFurnaceAugmentGreen","SlotIronFurnaceAugmentBlue","SlotIronFurnaceInputGenerator",
        "SlotIronFurnaceInputFactory","SlotIronFurnaceInputFactory","SlotIronFurnaceInputFactory","SlotIronFurnaceInputFactory","SlotIronFurnaceInputFactory","SlotIronFurnaceInputFactory",
        "SlotIronFurnaceOutputFactory","SlotIronFurnaceOutputFactory","SlotIronFurnaceOutputFactory","SlotIronFurnaceOutputFactory","SlotIronFurnaceOutputFactory","SlotIronFurnaceOutputFactory");
    private IronFurnaceAdapter() {}
    /** Built-in adapter, dispatched through {@link ModAdapters} like any add-on adapter. */
    static final ContainerAdapter INSTANCE=new ContainerAdapter() {
        public String id() {return ID;}
        public boolean installed() {return IronFurnaceAdapter.installed();}
        public boolean block(BlockState state) {return IronFurnaceAdapter.block(state);}
        public boolean entity(BlockEntity entity) {return IronFurnaceAdapter.entity(entity);}
        public MenuProvider provider(ServerPlayer player,BlockPos pos,BlockState state) {return IronFurnaceAdapter.provider(player,pos,state);}
        public boolean menu(AbstractContainerMenu menu) {return IronFurnaceAdapter.menu(menu);}
        public Container storage(AbstractContainerMenu menu,Inventory inventory) {return IronFurnaceAdapter.storage(menu,inventory);}
        public OptionalInt playerSlot(Slot slot,Inventory inventory) {
            Integer index=playerSource(slot,inventory).playerSlot();return index==null?OptionalInt.empty():OptionalInt.of(index);
        }
    };
    static boolean supportedIdentity(String version,String id,String blockClass) {return VERSION.equals(version)&&ID.equals(id)&&BLOCK.equals(blockClass);}
    static boolean supportedMode(boolean lit,int type,boolean furnace,boolean factory,boolean generator,boolean augmentGUI) {
        return !lit&&type==0&&furnace&&!factory&&!generator&&!augmentGUI;
    }
    private static String version(String mod) {return McbotApi.modVersion(mod);}
    private static boolean installed() {return McbotApi.versionsMatch("ironfurnaces",VERSION);}
    private static Object property(BlockState state,String name) {
        return state.getValues().entrySet().stream().filter(e->e.getKey().getName().equals(name)).map(Map.Entry::getValue).findFirst().orElse(null);
    }
    static boolean block(BlockState state) {
        return installed()&&supportedIdentity(version("ironfurnaces"),BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),state.getBlock().getClass().getName())&&
            Boolean.FALSE.equals(property(state,"lit"))&&Integer.valueOf(0).equals(property(state,"type"));
    }
    static boolean entity(Object entity) {return entity instanceof BlockEntity&&entity instanceof Container&&entity instanceof MenuProvider&&ENTITY.equals(entity.getClass().getName());}
    static MenuProvider provider(ServerPlayer player,BlockPos pos,BlockState state) {
        if(!block(state)) return null;
        var chunk=player.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
        BlockEntity entity=chunk==null?null:chunk.getBlockEntity(pos);
        return entity(entity)?(MenuProvider)entity:null;
    }
    static boolean menu(AbstractContainerMenu menu) {
        if(!installed()||!MENU.equals(menu.getClass().getName())||!ID.equals(BuiltInRegistries.MENU.getKey(menu.getType()).toString())||menu.slots.size()!=TOTAL_SLOTS) return false;
        Object entity=menu.slots.getFirst().container;
        if(!entity(entity)) return false;
        BlockState state=((BlockEntity)entity).getBlockState();
        if(!block(state)) return false;
        // Explicit mode methods are part of the checked 4.3.2 menu contract. Fail closed.
        try {
            boolean furnace=(boolean)menu.getClass().getMethod("getIsFurnace").invoke(menu);
            boolean factory=(boolean)menu.getClass().getMethod("getIsFactory").invoke(menu);
            boolean generator=(boolean)menu.getClass().getMethod("getIsGenerator").invoke(menu);
            boolean augment=(boolean)menu.getClass().getMethod("getAugmentGUI").invoke(menu);
            return supportedMode(false,0,furnace,factory,generator,augment);
        } catch(ReflectiveOperationException|ClassCastException unavailable) {return false;}
    }
    static Container storage(AbstractContainerMenu menu,Inventory inventory) {
        if(!menu(menu)) return null;
        List<NativeSlot> slots=menu.slots.stream().map(slot->new NativeSlot(slot.container,slot.getContainerSlot(),slot.container.getContainerSize(),slot.getClass().getName(),
            slot instanceof SlotItemHandler handler&&handler.getItemHandler() instanceof InvWrapper wrapper?wrapper.getInv():null)).toList();
        return (Container)verifiedContract(slots,inventory,inventory.getContainerSize());
    }
    static Object verifiedContract(List<NativeSlot> slots,Object inventory,int inventorySize) {
        if(slots.size()!=TOTAL_SLOTS) return null;
        Object storage=slots.getFirst().backing();
        if(storage==inventory) return null;
        for(int i=0;i<MACHINE_SLOTS;i++) {
            NativeSlot slot=slots.get(i);
            if(slot.backing()!=storage||slot.size()!=MACHINE_SLOTS||slot.index()!=i||!slot.className().equals(machineSlotClass(i))) return null;
        }
        for(int i=MACHINE_SLOTS;i<TOTAL_SLOTS;i++) {
            NativeSlot slot=slots.get(i);int expected=i<46?i-19+9:i-46;
            if(!slot.className().equals(SlotItemHandler.class.getName())||handlerSource(slot.wrappedInventory(),inventory,slot.index(),inventorySize).playerSlot()==null||slot.index()!=expected) return null;
        }
        return storage;
    }
    static String machineSlotClass(int index) {return "ironfurnaces.container.slots."+SLOT_CLASSES.get(index);}
    static MenuSlotSources.Source handlerSource(Object wrappedInventory,Object inventory,int nativeIndex,int inventorySize) {
        return wrappedInventory==inventory&&nativeIndex>=0&&nativeIndex<inventorySize?
            new MenuSlotSources.Source("player",nativeIndex):new MenuSlotSources.Source("unknown",null);
    }
    static MenuSlotSources.Source playerSource(Slot slot,Inventory inventory) {
        if(slot.getClass()==SlotItemHandler.class&&slot instanceof SlotItemHandler handler&&handler.getItemHandler() instanceof InvWrapper wrapper)
            return handlerSource(wrapper.getInv(),inventory,slot.getContainerSlot(),inventory.getContainerSize());
        return new MenuSlotSources.Source("unknown",null);
    }
}
