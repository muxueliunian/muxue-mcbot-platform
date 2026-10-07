package com.mcbot.servercontrol.api.workstation;

/**
 * How the core drives a workstation. Adapters pick one; the core does all walking, clicking, waiting and checking.
 * More templates (option buttons, in-place brewing, modifying gear) come with the stations that need them.
 */
public enum Template {
    /**
     * A crafting grid: ingredients go into {@link Port#INGREDIENT} cells laid out row-major in
     * {@link StationLayout#gridWidth()} x {@link StationLayout#gridHeight()}, the station shows the result in
     * {@link Port#RESULT}, taking it commits the craft. Recipes come from {@link RecipeSource#producing}.
     */
    GRID_CRAFTER,
    /**
     * A machine that works by itself once loaded: one {@link Port#INGREDIENT} input, an optional {@link Port#FUEL}
     * slot and a {@link Port#RESULT}. The recipe for an input comes from {@link RecipeSource#forInput}; the body may
     * wait beside it and take results as they come, or leave and collect later.
     */
    PROCESSOR,
    /**
     * One input, the result chosen with a menu button among {@link WorkstationAdapter#options}, taken from
     * {@link Port#RESULT} (stonecutter). Taking it commits.
     */
    OPTION_PICKER,
    /**
     * Machines that change {@link Port#SUBJECT} items where they stand once an {@link Port#INGREDIENT} and fuel are in
     * (brewing stand). Recipes come from {@link RecipeSource#transform}; the body waits beside it for each stage.
     */
    IN_PLACE,
    /**
     * Work on one chosen item ({@link Port#SUBJECT}) with optional {@link Port#CATALYST} inputs, an optional option
     * button and a level cost ({@link WorkstationAdapter#levelCost}): enchanting table, anvil, grindstone, smithing
     * table, loom, cartography table. Previewed first; only an explicitly referenced item is ever put in.
     */
    MODIFIER
}
