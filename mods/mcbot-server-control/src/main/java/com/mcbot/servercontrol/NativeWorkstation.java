package com.mcbot.servercontrol;

import com.google.gson.*;
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.*;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.*;
import net.minecraft.world.item.*;
import net.minecraft.world.item.crafting.*;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Crafting and furnace work through the ordinary player packets: grid and furnace slots are filled with PICKUP
 * clicks from the body's own stacks, results are taken with QUICK_MOVE (shift-click), so vanilla crafts, consumes,
 * returns remainders (empty buckets) and awards experience exactly as for a player. Only plain stacks (no custom
 * components: names, enchantments, damage) are used as ingredients or fuel. Shaped and shapeless crafting recipes
 * only; special recipes (fireworks, map copies, dyeing armour) are refused.
 */
final class NativeWorkstation {
    private NativeWorkstation() {}
    private static int sequence;

    // ---------- shared click helpers ----------
    static void click(ServerPlayer player,AbstractContainerMenu menu,int slot,int button,ClickType type) {
        player.connection.handleContainerClick(new ServerboundContainerClickPacket(menu.containerId,menu.getStateId(),slot,button,type,menu.getCarried().copy(),new Int2ObjectOpenHashMap<>()));
    }
    /** The menu slot showing inventory slot `index` (0..35), or -1. */
    static int menuSlot(AbstractContainerMenu menu,Inventory inventory,int index) {
        for(int i=0;i<menu.slots.size();i++){Slot s=menu.getSlot(i);if(s.container==inventory&&s.getContainerSlot()==index)return i;}
        return -1;
    }
    static boolean plain(ItemStack stack){return !stack.isEmpty()&&stack.getComponentsPatch().isEmpty();}
    static String id(ItemStack stack){return stack.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();}
    static String id(Item item){return BuiltInRegistries.ITEM.getKey(item).toString();}
    static Item item(String id) {
        ResourceLocation key=ResourceLocation.tryParse(id);
        if(key==null||!BuiltInRegistries.ITEM.containsKey(key))throw error("INVALID_ARGUMENT","Unknown item "+id);
        return BuiltInRegistries.ITEM.get(key);
    }
    static int total(Inventory inventory,Item item) {int n=0;for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(s.is(item))n+=s.getCount();}return n;}
    static Map<String,Integer> counts(Inventory inventory) {
        Map<String,Integer> result=new TreeMap<>();
        for(int i=0;i<inventory.getContainerSize();i++){ItemStack s=inventory.getItem(i);if(!s.isEmpty())result.merge(id(s),s.getCount(),Integer::sum);}
        return result;
    }
    static JsonObject delta(Map<String,Integer> before,Map<String,Integer> after) {
        JsonObject gained=new JsonObject(),used=new JsonObject();Set<String> keys=new TreeSet<>(before.keySet());keys.addAll(after.keySet());
        for(String key:keys){int d=after.getOrDefault(key,0)-before.getOrDefault(key,0);if(d>0)gained.addProperty(key,d);else if(d<0)used.addProperty(key,-d);}
        return obj("gained",gained,"used",used);
    }
    /**
     * Move exactly `count` items of a plain inventory stack into a menu slot: pick the whole stack up, right-click
     * the target once per item, put the rest back. Returns how many went in.
     */
    static int transfer(ServerPlayer player,AbstractContainerMenu menu,int fromInventory,int target,int count) {
        int from=menuSlot(menu,player.getInventory(),fromInventory);
        if(from<0||!menu.getCarried().isEmpty())throw error("UNKNOWN","Inventory slot is not in this menu or the cursor is busy");
        ItemStack source=menu.getSlot(from).getItem();if(source.isEmpty())return 0;
        int before=menu.getSlot(target).getItem().getCount(),put=0;
        click(player,menu,from,0,ClickType.PICKUP);
        for(int i=0;i<count&&!menu.getCarried().isEmpty();i++){
            click(player,menu,target,1,ClickType.PICKUP);
            int now=menu.getSlot(target).getItem().getCount();if(now==before+put)break;put=now-before;
        }
        if(!menu.getCarried().isEmpty())click(player,menu,from,0,ClickType.PICKUP);
        if(!menu.getCarried().isEmpty())throw error("UNKNOWN","Could not put the rest of the stack back; observe the inventory");
        return put;
    }
    /** Shift-click a menu slot into the inventory; true when it is empty afterwards. */
    static boolean quickMove(ServerPlayer player,AbstractContainerMenu menu,int slot) {
        if(menu.getSlot(slot).getItem().isEmpty())return true;
        click(player,menu,slot,0,ClickType.QUICK_MOVE);
        return menu.getSlot(slot).getItem().isEmpty();
    }
    static void closeMenu(ServerPlayer player) {
        if(player.containerMenu!=player.inventoryMenu)player.connection.handleContainerClose(new ServerboundContainerClosePacket(player.containerMenu.containerId));
    }
    /** Right-click a block like a player: the block's own use comes first, so the held item is not used on it. */
    static void use(ServerPlayer player,BlockPos pos) {
        BlockState state=player.serverLevel().getBlockState(pos);
        var shape=state.getShape(player.serverLevel(),pos);
        Vec3 aim=shape.isEmpty()?Vec3.atCenterOf(pos):shape.bounds().move(pos).getCenter();
        BlockHitResult hit=player.serverLevel().clip(new ClipContext(player.getEyePosition(),aim,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        if(hit.getType()!=HitResult.Type.BLOCK||!hit.getBlockPos().equals(pos))throw error("NO_LINE_OF_SIGHT","Workstation is obstructed");
        if(player.getEyePosition().distanceTo(hit.getLocation())>player.blockInteractionRange())throw error("OUT_OF_REACH","Workstation is out of reach");
        look(player,hit.getLocation());
        player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
    }
    static void look(ServerPlayer player,Vec3 target) {
        Vec3 delta=target.subtract(player.getEyePosition());float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z));
        player.setYRot(yaw);player.setYHeadRot(yaw);player.setXRot((float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance())));
    }
    static JsonObject pos(BlockPos p){return obj("x",p.getX(),"y",p.getY(),"z",p.getZ());}

    // ---------- crafting ----------
    /** One way to craft the item: the grid cells (row-major in a `width`-wide box; null cells stay empty). */
    record Plan(ResourceLocation id,ItemStack result,int width,int height,List<Ingredient> cells) {
        boolean fits(int grid){return width<=grid&&height<=grid;}
    }
    static List<Plan> plans(ServerPlayer player,Item wanted) {
        List<Plan> plans=new ArrayList<>();
        for(RecipeHolder<CraftingRecipe> holder:player.getServer().getRecipeManager().getAllRecipesFor(RecipeType.CRAFTING)) {
            CraftingRecipe recipe=holder.value();
            ItemStack result=recipe.getResultItem(player.registryAccess());
            if(result.isEmpty()||!result.is(wanted))continue;
            if(recipe instanceof ShapedRecipe shaped) {
                List<Ingredient> cells=new ArrayList<>();for(Ingredient ingredient:shaped.getIngredients())cells.add(ingredient.isEmpty()?null:ingredient);
                plans.add(new Plan(holder.id(),result,shaped.getWidth(),shaped.getHeight(),cells));
            } else if(recipe instanceof ShapelessRecipe shapeless) {
                int n=shapeless.getIngredients().size();if(n==0||n>9)continue;
                int width=n<=4?2:3;List<Ingredient> cells=new ArrayList<>(shapeless.getIngredients());
                while(cells.size()<width*((n+width-1)/width))cells.add(null);
                plans.add(new Plan(holder.id(),result,width,(n+width-1)/width,cells));
            }
        }
        // Simpler recipes first (fewer cells), so the 2x2 grid is tried before a table is needed.
        plans.sort(Comparator.comparingInt((Plan p)->p.width()*p.height()).thenComparing(p->p.id().toString()));
        return plans;
    }
    /** Inventory slot → count taken, per grid cell; null when `crafts` crafts cannot be laid out from plain stacks. */
    static List<Map<Integer,Integer>> allocate(Plan plan,Inventory inventory,int crafts) {
        int[] left=new int[36];for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);left[i]=plain(s)?s.getCount():0;}
        List<Map<Integer,Integer>> layout=new ArrayList<>();
        for(Ingredient ingredient:plan.cells()) {
            if(ingredient==null){layout.add(Map.of());continue;}
            // One item kind per cell (a grid slot holds one stack); the kind with the most left over.
            Map<Item,Integer> kinds=new HashMap<>();
            for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(left[i]>0&&ingredient.test(s)&&s.getMaxStackSize()>=crafts)kinds.merge(s.getItem(),left[i],Integer::sum);}
            Item best=null;int most=0;for(var e:kinds.entrySet())if(e.getValue()>=crafts&&e.getValue()>most){best=e.getKey();most=e.getValue();}
            if(best==null)return null;
            Map<Integer,Integer> take=new LinkedHashMap<>();int need=crafts;
            List<Integer> slots=new ArrayList<>();for(int i=0;i<36;i++)if(left[i]>0&&inventory.getItem(i).is(best))slots.add(i);
            slots.sort(Comparator.comparingInt(i->-left[i]));
            for(int i:slots){if(need==0)break;int n=Math.min(need,left[i]);take.put(i,n);left[i]-=n;need-=n;}
            layout.add(take);
        }
        return layout;
    }
    /** The largest number of crafts (≤ wanted) this plan can lay out in one round. */
    static int feasible(Plan plan,Inventory inventory,int wanted) {
        for(int k=Math.min(wanted,64);k>0;k--)if(allocate(plan,inventory,k)!=null)return k;
        return 0;
    }
    /** What is short for `crafts` crafts of this plan: each distinct ingredient, its options, needed and held. */
    static JsonArray missing(Plan plan,Inventory inventory,int crafts) {
        Map<String,int[]> need=new LinkedHashMap<>();Map<String,Ingredient> by=new HashMap<>();
        for(Ingredient ingredient:plan.cells()) {
            if(ingredient==null)continue;
            StringBuilder key=new StringBuilder();for(ItemStack option:ingredient.getItems())key.append(id(option)).append(',');
            need.computeIfAbsent(key.toString(),k->new int[2])[0]+=crafts;by.put(key.toString(),ingredient);
        }
        JsonArray result=new JsonArray();
        for(var entry:need.entrySet()) {
            Ingredient ingredient=by.get(entry.getKey());int have=0;
            for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&ingredient.test(s))have+=s.getCount();}
            if(have>=entry.getValue()[0])continue;
            JsonArray options=new JsonArray();ItemStack[] items=ingredient.getItems();
            for(int i=0;i<Math.min(items.length,6);i++)options.add(id(items[i]));
            JsonObject line=obj("options",options,"need",entry.getValue()[0],"have",have);
            if(items.length>6)line.addProperty("moreOptions",items.length-6);
            result.add(line);
        }
        return result;
    }
    /** Grid slot index (1-based after the result slot) for a plan cell in a grid of the given width. */
    private static int gridSlot(AbstractContainerMenu menu,int grid,Plan plan,int cell) {
        int row=cell/plan.width(),col=cell%plan.width();
        return 1+row*grid+col;
    }
    /**
     * Craft up to `crafts` times in an open crafting grid (the body's own 2x2, or an opened table's 3x3).
     * Returns the number of crafts done; leftovers go back to the inventory.
     */
    static int craft(ServerPlayer player,AbstractContainerMenu menu,int grid,Plan plan,int crafts) {
        if(!menu.getCarried().isEmpty())throw error("BUSY","The cursor holds an item");
        for(int i=1;i<=grid*grid;i++)if(!quickMove(player,menu,i))throw error("BUSY","The crafting grid is not empty and the inventory has no room");
        Inventory inventory=player.getInventory();
        int done=0;
        while(done<crafts) {
            int k=feasible(plan,inventory,crafts-done);if(k==0)break;
            List<Map<Integer,Integer>> layout=allocate(plan,inventory,k);
            for(int cell=0;cell<layout.size();cell++){
                int target=gridSlot(menu,grid,plan,cell);
                for(var take:layout.get(cell).entrySet())transfer(player,menu,take.getKey(),target,take.getValue());
            }
            ItemStack shown=menu.getSlot(0).getItem();
            if(shown.isEmpty()||!ItemStack.isSameItem(shown,plan.result())) {
                for(int i=1;i<=grid*grid;i++)quickMove(player,menu,i);
                throw error("RECIPE_REFUSED","The game did not offer this recipe in the grid (limited crafting or a mod rule)");
            }
            int before=total(inventory,plan.result().getItem());
            quickMove(player,menu,0);
            int made=(total(inventory,plan.result().getItem())-before)/Math.max(1,plan.result().getCount());
            for(int i=1;i<=grid*grid;i++)quickMove(player,menu,i);
            if(made<=0)throw error("INVENTORY_FULL","No room in the inventory for the result");
            done+=made;
            if(made<k)break; // inventory full
        }
        return done;
    }

    // ---------- furnaces ----------
    static RecipeType<? extends AbstractCookingRecipe> cookingType(BlockState state) {
        Block block=state.getBlock();
        if(block==Blocks.FURNACE)return RecipeType.SMELTING;
        if(block==Blocks.SMOKER)return RecipeType.SMOKING;
        if(block==Blocks.BLAST_FURNACE)return RecipeType.BLASTING;
        return null; // modded furnaces go through their adapters (8b)
    }
    static Optional<? extends RecipeHolder<? extends AbstractCookingRecipe>> cooking(ServerPlayer player,RecipeType<? extends AbstractCookingRecipe> type,ItemStack input) {
        @SuppressWarnings("unchecked") RecipeType<AbstractCookingRecipe> raw=(RecipeType<AbstractCookingRecipe>)type;
        return player.getServer().getRecipeManager().getRecipeFor(raw,new SingleRecipeInput(input),player.level());
    }
    /** Fuel the body would pick by itself: coal and charcoal, then planks, logs, sticks and wooden slabs. Never the input. */
    static int fuelRank(ItemStack stack,Item input,RecipeType<?> type) {
        if(!plain(stack)||stack.is(input)||stack.getBurnTime(type)<=0)return -1;
        if(stack.is(Items.COAL)||stack.is(Items.CHARCOAL))return 0;
        if(stack.is(ItemTags.PLANKS))return 1;
        if(stack.is(ItemTags.LOGS_THAT_BURN))return 2;
        if(stack.is(Items.STICK)||stack.is(ItemTags.WOODEN_SLABS))return 3;
        if(stack.is(Items.COAL_BLOCK))return 4;
        return -1;
    }
}
