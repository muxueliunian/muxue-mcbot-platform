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
    PROCESSOR
}
