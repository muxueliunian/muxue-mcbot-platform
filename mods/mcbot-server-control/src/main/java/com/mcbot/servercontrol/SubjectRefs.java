package com.mcbot.servercontrol;

import java.security.SecureRandom;
import java.util.*;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Short-lived references to one exact stack in the body's main inventory, for actions that work on a chosen item
 * (enchanting, anvil, grindstone). A reference is random, not derived from the item; it stays valid only while the
 * same slot still holds exactly the same stack (item, count and every component), and for at most 15 minutes.
 */
final class SubjectRefs {
    static final long LIFETIME_MS=15*60_000;static final int MAX=64;
    private record Entry(UUID player,int slot,ItemStack stack,long expires) {}
    private static final SecureRandom RANDOM=new SecureRandom();
    private static final char[] ALPHABET="abcdefghijkmnpqrstuvwxyz23456789".toCharArray();
    private final Map<String,Entry> refs=new LinkedHashMap<>();
    private final java.util.function.LongSupplier clock;
    SubjectRefs(){this(System::currentTimeMillis);}
    SubjectRefs(java.util.function.LongSupplier clock){this.clock=clock;}

    /** A new reference to the stack now in main-inventory slot 0..35. */
    String issue(ServerPlayer player,int slot) {
        if(slot<0||slot>35||player.getInventory().getItem(slot).isEmpty())throw error("INVALID_ARGUMENT","No item in inventory slot "+slot);
        return issue(player.getUUID(),slot,player.getInventory().getItem(slot));
    }
    String issue(UUID player,int slot,ItemStack stack) {
        long now=clock.getAsLong();refs.values().removeIf(e->e.expires()<now);
        while(refs.size()>=MAX)refs.remove(refs.keySet().iterator().next());
        StringBuilder ref=new StringBuilder("item-");for(int i=0;i<8;i++)ref.append(ALPHABET[RANDOM.nextInt(ALPHABET.length)]);
        refs.put(ref.toString(),new Entry(player,slot,stack.copy(),now+LIFETIME_MS));
        return ref.toString();
    }
    /** The inventory slot a reference points at, after checking it still holds exactly the same stack. */
    int resolve(ServerPlayer player,String ref){return resolve(player.getUUID(),ref,player.getInventory()::getItem);}
    int resolve(UUID player,String ref,java.util.function.IntFunction<ItemStack> slots) {
        Entry entry=refs.get(ref);
        if(entry==null||!entry.player().equals(player))throw error("STALE_SUBJECT","Unknown item reference "+ref+"; ask workstation-options for a fresh one");
        if(entry.expires()<clock.getAsLong()){refs.remove(ref);throw error("STALE_SUBJECT","Item reference "+ref+" expired; ask workstation-options again");}
        if(!ItemStack.matches(entry.stack(),slots.apply(entry.slot()))){refs.remove(ref);throw error("STALE_SUBJECT","The referenced item moved or changed; ask workstation-options again");}
        return entry.slot();
    }
    void forget(String ref){refs.remove(ref);}
    /**
     * After the body took the referenced stack out of a station unchanged, point the reference at the slot it landed
     * in: the old slot when it still holds exactly that stack, otherwise the first slot that does. Without one the
     * reference is dropped.
     */
    void rebind(ServerPlayer player,String ref) {
        Entry entry=refs.get(ref);if(entry==null)return;
        var inventory=player.getInventory();
        if(ItemStack.matches(entry.stack(),inventory.getItem(entry.slot())))return;
        for(int i=0;i<36;i++)if(ItemStack.matches(entry.stack(),inventory.getItem(i))){refs.put(ref,new Entry(entry.player(),i,entry.stack(),entry.expires()));return;}
        refs.remove(ref);
    }
}
