package com.mcbot.servercontrol;

import com.mcbot.servercontrol.api.workstation.*;
import com.mcbot.servercontrol.platform.LoaderPlatform;
import java.util.*;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.*;
import net.minecraft.world.item.*;
import net.minecraft.world.item.crafting.*;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Built-in adapters for the vanilla workstations, on the same interface add-ons use. Vanilla blocks are only ever
 * handled here ({@link ModAdapters#workstation}). The body's own 2x2 grid is {@link #INVENTORY}: no block, its
 * menu is the player's inventory menu.
 */
final class VanillaWorkstations {
    private VanillaWorkstations() {}

    /** Shaped and shapeless crafting recipes; special ones (fireworks, map copies, dyeing armour) are left out. */
    static final RecipeSource CRAFTING=new RecipeSource() {
        @Override public List<StationRecipe> producing(ServerPlayer player,Item wanted) {
            List<StationRecipe> recipes=new ArrayList<>();
            for(RecipeHolder<CraftingRecipe> holder:player.getServer().getRecipeManager().getAllRecipesFor(RecipeType.CRAFTING)) {
                CraftingRecipe recipe=holder.value();
                ItemStack result=recipe.getResultItem(player.registryAccess());
                if(result.isEmpty()||!result.is(wanted))continue;
                if(recipe instanceof ShapedRecipe shaped) {
                    recipes.add(new StationRecipe(holder.id(),result,shaped.getWidth(),shaped.getHeight(),shaped.getIngredients(),0,0));
                } else if(recipe instanceof ShapelessRecipe shapeless) {
                    int n=shapeless.getIngredients().size();if(n==0||n>9)continue;
                    int width=n<=4?2:3,height=(n+width-1)/width;List<Ingredient> cells=new ArrayList<>(shapeless.getIngredients());
                    while(cells.size()<width*height)cells.add(Ingredient.EMPTY);
                    recipes.add(new StationRecipe(holder.id(),result,width,height,cells,0,0));
                }
            }
            // Simpler recipes first (fewer cells), so the 2x2 grid is tried before a table is needed.
            recipes.sort(Comparator.comparingInt((StationRecipe r)->r.width()*r.height()).thenComparing(r->r.id().toString()));
            return recipes;
        }
    };

    private static boolean craftingGrid(AbstractContainerMenu menu,int cells) {
        if(menu.slots.size()<1+cells||!(menu.getSlot(0) instanceof ResultSlot))return false;
        for(int i=1;i<=cells;i++){Slot slot=menu.getSlot(i);if(!(slot.container instanceof CraftingContainer grid)||grid.getContainerSize()!=cells||slot.getContainerSlot()!=i-1)return false;}
        return true;
    }

    static final WorkstationAdapter INVENTORY=new WorkstationAdapter() {
        public String id(){return "minecraft:inventory_crafting";}
        public boolean installed(){return true;}
        public Template template(){return Template.GRID_CRAFTER;}
        public boolean block(BlockState state){return false;}
        public boolean menu(AbstractContainerMenu menu){return menu instanceof InventoryMenu;}
        public StationLayout layout(AbstractContainerMenu menu){return craftingGrid(menu,4)?StationLayout.grid(0,1,2,2):null;}
        public RecipeSource recipes(BlockState state){return CRAFTING;}
    };

    static final WorkstationAdapter CRAFTING_TABLE=new WorkstationAdapter() {
        public String id(){return "minecraft:crafting_table";}
        public boolean installed(){return true;}
        public Template template(){return Template.GRID_CRAFTER;}
        public boolean block(BlockState state){return state.is(Blocks.CRAFTING_TABLE);}
        public boolean menu(AbstractContainerMenu menu){return menu instanceof CraftingMenu&&menu.getType()==MenuType.CRAFTING;}
        public StationLayout layout(AbstractContainerMenu menu){return craftingGrid(menu,9)?StationLayout.grid(0,1,3,3):null;}
        public RecipeSource recipes(BlockState state){return CRAFTING;}
    };

    /** Furnace, smoker, blast furnace: input 0, fuel 1, result 2, each with its own recipe type and menu type. */
    private record Cooker(String id,Block block,MenuType<?> menuType,RecipeType<? extends AbstractCookingRecipe> type) implements WorkstationAdapter {
        public boolean installed(){return true;}
        public Template template(){return Template.PROCESSOR;}
        public boolean block(BlockState state){return state.is(block);}
        public boolean menu(AbstractContainerMenu menu){return menu instanceof AbstractFurnaceMenu&&menu.getType()==menuType;}
        public StationLayout layout(AbstractContainerMenu menu) {
            if(menu.slots.size()<3||!(menu.getSlot(1) instanceof FurnaceFuelSlot)||!(menu.getSlot(2) instanceof FurnaceResultSlot))return null;
            return StationLayout.processor(0,1,2);
        }
        public RecipeSource recipes(BlockState state) {
            return new RecipeSource() {
                @Override public Optional<StationRecipe> forInput(ServerPlayer player,ItemStack input) {
                    @SuppressWarnings("unchecked") RecipeType<AbstractCookingRecipe> raw=(RecipeType<AbstractCookingRecipe>)type;
                    return player.getServer().getRecipeManager().getRecipeFor(raw,new SingleRecipeInput(input),player.level()).map(holder->{
                        AbstractCookingRecipe recipe=holder.value();
                        Ingredient ingredient=recipe.getIngredients().isEmpty()?Ingredient.of(input.getItem()):recipe.getIngredients().getFirst();
                        return StationRecipe.processing(holder.id(),recipe.getResultItem(player.registryAccess()),ingredient,recipe.getCookingTime(),recipe.getExperience());
                    });
                }
            };
        }
        public int burnTicks(BlockState state,ItemStack fuel){return LoaderPlatform.get().burnTime(fuel,type);}
        public boolean working(AbstractContainerMenu menu){return menu instanceof AbstractFurnaceMenu furnace&&furnace.isLit();}
    }
    static final WorkstationAdapter FURNACE=new Cooker("minecraft:furnace",Blocks.FURNACE,MenuType.FURNACE,RecipeType.SMELTING);
    static final WorkstationAdapter SMOKER=new Cooker("minecraft:smoker",Blocks.SMOKER,MenuType.SMOKER,RecipeType.SMOKING);
    static final WorkstationAdapter BLAST_FURNACE=new Cooker("minecraft:blast_furnace",Blocks.BLAST_FURNACE,MenuType.BLAST_FURNACE,RecipeType.BLASTING);

    static final List<WorkstationAdapter> ALL=List.of(CRAFTING_TABLE,FURNACE,SMOKER,BLAST_FURNACE);
}
