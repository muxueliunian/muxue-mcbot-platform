package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.*;
import java.util.List;
import static com.mcbot.servercontrol.Protocol.*;

/** Ownership follows actual inventory identity, never the position of the last 36 slots. */
final class MenuSlotSources {
    record BackingSlot(Object container,int nativeIndex,int size) {}
    record Source(String source,Integer playerSlot) {}
    private MenuSlotSources() {}

    static Container storage(AbstractContainerMenu menu, Inventory inventory) {
        if(menu instanceof ChestMenu chest) return chest.getContainer();
        if(IronFurnaceAdapter.menu(menu)) return IronFurnaceAdapter.storage(menu,inventory);
        // These version-pinned native constructors put their real storage in slots 0..N-1.
        // Validate both identity and native indices; a changed adapter contract stays unknown.
        int count=menu instanceof HopperMenu?5:menu instanceof DispenserMenu?9:
            menu instanceof ShulkerBoxMenu?27:menu instanceof AbstractFurnaceMenu?3:0;
        return verifiedStorage(menu.slots,inventory,count);
    }

    static Container verifiedStorage(List<Slot> slots,Inventory inventory,int count) {
        if(count<=0||slots.size()<count) return null;
        List<BackingSlot> backing=slots.subList(0,count).stream()
            .map(slot->new BackingSlot(slot.container,slot.getContainerSlot(),slot.container.getContainerSize())).toList();
        return (Container)verifiedBacking(backing,inventory,count);
    }
    static Object verifiedBacking(List<BackingSlot> slots,Object inventory,int count) {
        if(count<=0||slots.size()<count) return null;
        BackingSlot first=slots.getFirst();
        if(first.container()==inventory||first.size()<count) return null;
        for(int i=0;i<count;i++)
            if(slots.get(i).container()!=first.container()||slots.get(i).nativeIndex()!=i||slots.get(i).size()!=first.size()) return null;
        return first.container();
    }
    static Source classify(BackingSlot slot,Object inventory,int inventorySize,Object storage) {
        int index=slot.nativeIndex();
        if(slot.container()==inventory&&index>=0&&index<inventorySize) return new Source("player",index);
        if(storage!=null&&slot.container()==storage&&index>=0&&index<slot.size()) return new Source("container",null);
        return new Source("unknown",null);
    }

    static JsonObject annotate(JsonObject stack,Slot slot,Inventory inventory,Container storage,boolean ironFurnace) {
        Source source=classify(new BackingSlot(slot.container,slot.getContainerSlot(),slot.container.getContainerSize()),inventory,inventory.getContainerSize(),storage);
        if(ironFurnace&&source.source().equals("unknown")) source=IronFurnaceAdapter.playerSource(slot,inventory);
        stack.addProperty("source",source.source());
        if(source.playerSlot()!=null) stack.addProperty("playerSlot",source.playerSlot());
        return stack;
    }
}
