package com.mcbot.servercontrol.api.workstation;

/** Logical role of a workstation slot; the core decides what it may put in or take out by the role, never by slot number. */
public enum Port {
    /** Ordinary ingredients that are consumed: crafting grid cells, a furnace's input, a cooking pot's six slots. */
    INGREDIENT,
    /** The item being worked on, whose result may stay in the same slot: brewing bottles, the anvil's left slot. */
    SUBJECT,
    /** A second input or catalyst: the anvil's right slot, lapis in the enchanting table, a smithing template. */
    CATALYST,
    /** The station's own fuel. */
    FUEL,
    /** What the result is served into (a cooking pot's bowl). */
    CONTAINER,
    /** A finished result that can be taken. */
    RESULT,
    /** Work in progress inside the machine: observed, never taken. */
    BUFFER
}
