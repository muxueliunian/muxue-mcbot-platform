package com.mcbot.servercontrol;

import com.mcbot.servercontrol.api.workstation.*;
import com.mcbot.servercontrol.platform.LoaderPlatform;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.*;
import net.minecraft.world.item.*;
import net.minecraft.world.item.crafting.*;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.AbstractFurnaceBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
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
        /** Slots from the block entity; burn and cook times from its saved data (1.21.1 keys BurnTime, CookTime, CookTimeTotal). */
        public StationProgress progress(Level level,BlockPos pos,BlockState state) {
            if(!block(state)||!(level.getBlockEntity(pos) instanceof AbstractFurnaceBlockEntity furnace))return null;
            ItemStack input=furnace.getItem(0),fuel=furnace.getItem(1),result=furnace.getItem(2);
            var saved=furnace.saveWithoutMetadata(level.registryAccess());
            int burning=saved.getShort("BurnTime"),cooked=saved.getShort("CookTime"),total=saved.getShort("CookTimeTotal");
            boolean lit=state.hasProperty(AbstractFurnaceBlock.LIT)&&state.getValue(AbstractFurnaceBlock.LIT);
            int left=input.isEmpty()?0:total<=0?-1:Math.max(0,input.getCount()*total-cooked);
            int fuelTicks=burning+(fuel.isEmpty()?0:fuel.getCount()*burnTicks(state,fuel));
            return new StationProgress(List.of(input),List.of(result),fuel,lit,left,fuelTicks);
        }
    }
    static final WorkstationAdapter FURNACE=new Cooker("minecraft:furnace",Blocks.FURNACE,MenuType.FURNACE,RecipeType.SMELTING);
    static final WorkstationAdapter SMOKER=new Cooker("minecraft:smoker",Blocks.SMOKER,MenuType.SMOKER,RecipeType.SMOKING);
    static final WorkstationAdapter BLAST_FURNACE=new Cooker("minecraft:blast_furnace",Blocks.BLAST_FURNACE,MenuType.BLAST_FURNACE,RecipeType.BLASTING);

    // ---------- B and C: stonecutter, brewing stand, gear and banner stations ----------
    /** The first `machine` menu slots are the station's own (not the player's inventory) and the player's 36 follow. */
    static boolean machineSlots(AbstractContainerMenu menu,int machine) {
        if(menu.slots.size()!=machine+36)return false;
        for(int i=0;i<machine;i++)if(menu.getSlot(i).container instanceof net.minecraft.world.entity.player.Inventory)return false;
        for(int i=machine;i<machine+36;i++)if(!(menu.getSlot(i).container instanceof net.minecraft.world.entity.player.Inventory))return false;
        return true;
    }
    /** A vanilla station identified by block, menu class and menu type, with a fixed layout over `machine` own slots. */
    private abstract static class Fixed implements WorkstationAdapter {
        private final String id;private final Template template;private final java.util.function.Predicate<BlockState> block;
        private final Class<? extends AbstractContainerMenu> menuClass;private final MenuType<?> type;private final int machine;private final StationLayout layout;
        Fixed(String id,Template template,java.util.function.Predicate<BlockState> block,Class<? extends AbstractContainerMenu> menuClass,MenuType<?> type,int machine,StationLayout layout) {
            this.id=id;this.template=template;this.block=block;this.menuClass=menuClass;this.type=type;this.machine=machine;this.layout=layout;
        }
        public String id(){return id;}
        public boolean installed(){return true;}
        public Template template(){return template;}
        public boolean block(BlockState state){return block.test(state);}
        public boolean menu(AbstractContainerMenu menu){return menuClass.isInstance(menu)&&menu.getType()==type;}
        public StationLayout layout(AbstractContainerMenu menu){return machineSlots(menu,machine)?layout:null;}
        public RecipeSource recipes(BlockState state){return new RecipeSource(){};}
    }
    private static StationLayout ports(Object... pairs) {
        Map<Port,List<Integer>> map=new EnumMap<>(Port.class);
        for(int i=0;i<pairs.length;i+=2){List<Integer> slots=new ArrayList<>();for(int s:(int[])pairs[i+1])slots.add(s);map.put((Port)pairs[i],slots);}
        return new StationLayout(map,0,0);
    }

    static final RecipeSource STONECUTTING=new RecipeSource() {
        @Override public List<StationRecipe> producing(ServerPlayer player,Item wanted) {
            List<StationRecipe> recipes=new ArrayList<>();
            for(RecipeHolder<StonecutterRecipe> holder:player.getServer().getRecipeManager().getAllRecipesFor(RecipeType.STONECUTTING)) {
                ItemStack result=holder.value().getResultItem(player.registryAccess());
                if(result.isEmpty()||!result.is(wanted)||holder.value().getIngredients().isEmpty())continue;
                recipes.add(StationRecipe.processing(holder.id(),result,holder.value().getIngredients().getFirst(),0,0));
            }
            // Most results per input first.
            recipes.sort(Comparator.comparingInt((StationRecipe r)->-r.result().getCount()).thenComparing(r->r.id().toString()));
            return recipes;
        }
    };
    static final WorkstationAdapter STONECUTTER=new Fixed("minecraft:stonecutter",Template.OPTION_PICKER,s->s.is(Blocks.STONECUTTER),StonecutterMenu.class,MenuType.STONECUTTER,2,
            ports(Port.INGREDIENT,new int[]{0},Port.RESULT,new int[]{1})) {
        @Override public RecipeSource recipes(BlockState state){return STONECUTTING;}
        @Override public List<StationOption> options(ServerPlayer player,AbstractContainerMenu menu) {
            List<StationOption> options=new ArrayList<>();var recipes=((StonecutterMenu)menu).getRecipes();
            for(int i=0;i<recipes.size();i++)options.add(new StationOption(i,recipes.get(i).id().toString(),recipes.get(i).value().getResultItem(player.registryAccess()),0,""));
            return options;
        }
    };

    /** Brewing as the server's own PotionBrewing rules (data packs and mods extend them); one stage = one reagent. */
    static final RecipeSource BREWING=new RecipeSource() {
        @Override public boolean isIngredient(ServerPlayer player,ItemStack ingredient){return player.serverLevel().potionBrewing().isIngredient(ingredient);}
        @Override public Optional<ItemStack> transform(ServerPlayer player,ItemStack subject,ItemStack ingredient) {
            var brewing=player.serverLevel().potionBrewing();
            if(subject.isEmpty()||!brewing.hasMix(subject,ingredient))return Optional.empty();
            ItemStack result=brewing.mix(ingredient,subject.copy());
            return ItemStack.isSameItemSameComponents(result,subject)?Optional.empty():Optional.of(result);
        }
    };
    static final WorkstationAdapter BREWING_STAND=new Fixed("minecraft:brewing_stand",Template.IN_PLACE,s->s.is(Blocks.BREWING_STAND),BrewingStandMenu.class,MenuType.BREWING_STAND,5,
            ports(Port.SUBJECT,new int[]{0,1,2},Port.INGREDIENT,new int[]{3},Port.FUEL,new int[]{4})) {
        @Override public RecipeSource recipes(BlockState state){return BREWING;}
        @Override public int burnTicks(BlockState state,ItemStack fuel){return fuel.is(Items.BLAZE_POWDER)?20:0;}
        @Override public int fuelLeft(AbstractContainerMenu menu){return ((BrewingStandMenu)menu).getFuel();}
        @Override public boolean working(AbstractContainerMenu menu){return ((BrewingStandMenu)menu).getBrewingTicks()>0;}
        /** Bottles 0-2, reagent 3, blaze powder 4; brew time counts down from 400 (1.21.1 saved key BrewTime). */
        @Override public StationProgress progress(Level level,BlockPos pos,BlockState state) {
            if(!block(state)||!(level.getBlockEntity(pos) instanceof BrewingStandBlockEntity stand))return null;
            int brewing=stand.saveWithoutMetadata(level.registryAccess()).getShort("BrewTime");
            return new StationProgress(List.of(stand.getItem(3)),List.of(stand.getItem(0),stand.getItem(1),stand.getItem(2)),stand.getItem(4),brewing>0,stand.getItem(3).isEmpty()?0:brewing>0?brewing:-1,-1);
        }
    };

    static final WorkstationAdapter ENCHANTING_TABLE=new Fixed("minecraft:enchanting_table",Template.MODIFIER,s->s.is(Blocks.ENCHANTING_TABLE),EnchantmentMenu.class,MenuType.ENCHANTMENT,2,
            ports(Port.SUBJECT,new int[]{0},Port.CATALYST,new int[]{1})) {
        /** The three offers as the player sees them: level requirement and the one enchantment the game reveals. */
        @Override public List<StationOption> options(ServerPlayer player,AbstractContainerMenu menu) {
            EnchantmentMenu table=(EnchantmentMenu)menu;List<StationOption> options=new ArrayList<>();
            var ids=player.registryAccess().registryOrThrow(net.minecraft.core.registries.Registries.ENCHANTMENT).asHolderIdMap();
            for(int i=0;i<3;i++) {
                if(table.costs[i]<=0)continue;
                String hint="";
                if(table.enchantClue[i]>=0){var holder=ids.byId(table.enchantClue[i]);hint=(holder==null?"?":holder.unwrapKey().map(k->k.location().toString()).orElse("?"))+" "+table.levelClue[i]+" (and maybe more)";}
                options.add(new StationOption(i,"slot"+(i+1),ItemStack.EMPTY,table.costs[i],hint));
            }
            return options;
        }
    };
    static final WorkstationAdapter ANVIL=new Fixed("minecraft:anvil",Template.MODIFIER,s->s.is(net.minecraft.tags.BlockTags.ANVIL),AnvilMenu.class,MenuType.ANVIL,3,
            ports(Port.SUBJECT,new int[]{0},Port.CATALYST,new int[]{1},Port.RESULT,new int[]{2})) {
        @Override public int levelCost(AbstractContainerMenu menu){return ((AnvilMenu)menu).getCost();}
    };
    static final WorkstationAdapter GRINDSTONE=new Fixed("minecraft:grindstone",Template.MODIFIER,s->s.is(Blocks.GRINDSTONE),GrindstoneMenu.class,MenuType.GRINDSTONE,3,
            ports(Port.SUBJECT,new int[]{0},Port.CATALYST,new int[]{1},Port.RESULT,new int[]{2})) {};
    /** Template 0, base 1 (the item worked on), addition 2, result 3. */
    static final WorkstationAdapter SMITHING_TABLE=new Fixed("minecraft:smithing_table",Template.MODIFIER,s->s.is(Blocks.SMITHING_TABLE),SmithingMenu.class,MenuType.SMITHING,4,
            ports(Port.CATALYST,new int[]{0,2},Port.SUBJECT,new int[]{1},Port.RESULT,new int[]{3})) {};
    /** Banner 0, dye 1, pattern item 2, result 3; the pattern is a button among the selectable ones. */
    static final WorkstationAdapter LOOM=new Fixed("minecraft:loom",Template.MODIFIER,s->s.is(Blocks.LOOM),LoomMenu.class,MenuType.LOOM,4,
            ports(Port.SUBJECT,new int[]{0},Port.CATALYST,new int[]{1,2},Port.RESULT,new int[]{3})) {
        @Override public List<StationOption> options(ServerPlayer player,AbstractContainerMenu menu) {
            List<StationOption> options=new ArrayList<>();var patterns=((LoomMenu)menu).getSelectablePatterns();
            for(int i=0;i<patterns.size();i++)options.add(new StationOption(i,patterns.get(i).unwrapKey().map(k->k.location().toString()).orElse("?"),ItemStack.EMPTY,0,""));
            return options;
        }
    };
    static final WorkstationAdapter CARTOGRAPHY_TABLE=new Fixed("minecraft:cartography_table",Template.MODIFIER,s->s.is(Blocks.CARTOGRAPHY_TABLE),CartographyTableMenu.class,MenuType.CARTOGRAPHY_TABLE,3,
            ports(Port.SUBJECT,new int[]{0},Port.CATALYST,new int[]{1},Port.RESULT,new int[]{2})) {};

    static final List<WorkstationAdapter> ALL=List.of(CRAFTING_TABLE,FURNACE,SMOKER,BLAST_FURNACE,STONECUTTER,BREWING_STAND,
        ENCHANTING_TABLE,ANVIL,GRINDSTONE,SMITHING_TABLE,LOOM,CARTOGRAPHY_TABLE);
}
