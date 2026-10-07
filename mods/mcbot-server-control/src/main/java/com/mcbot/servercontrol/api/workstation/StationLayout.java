package com.mcbot.servercontrol.api.workstation;

import java.util.*;

/**
 * Menu slot numbers of an opened, verified workstation menu, by logical {@link Port}. A slot belongs to at most one
 * port; slots not listed are never touched. For a crafting grid the {@link Port#INGREDIENT} slots are the cells
 * row-major in {@code gridWidth x gridHeight}; other templates leave the grid size 0.
 */
public record StationLayout(Map<Port, List<Integer>> slots, int gridWidth, int gridHeight) {
    public StationLayout {
        EnumMap<Port, List<Integer>> copy = new EnumMap<>(Port.class);
        Set<Integer> seen = new HashSet<>();
        for (var entry : Objects.requireNonNull(slots, "slots").entrySet()) {
            List<Integer> list = List.copyOf(entry.getValue());
            for (int slot : list) {
                if (slot < 0) throw new IllegalArgumentException("Negative menu slot " + slot);
                if (!seen.add(slot)) throw new IllegalArgumentException("Menu slot " + slot + " is in two ports");
            }
            if (!list.isEmpty()) copy.put(entry.getKey(), list);
        }
        if (gridWidth < 0 || gridHeight < 0) throw new IllegalArgumentException("Negative grid size");
        if (gridWidth * gridHeight > 0 && copy.getOrDefault(Port.INGREDIENT, List.of()).size() != gridWidth * gridHeight)
            throw new IllegalArgumentException("A " + gridWidth + "x" + gridHeight + " grid needs " + gridWidth * gridHeight + " ingredient slots");
        slots = Collections.unmodifiableMap(copy);
    }

    /** A crafting grid: result slot, then the cells row-major starting at {@code firstCell} (vanilla menus number them so). */
    public static StationLayout grid(int result, int firstCell, int width, int height) {
        List<Integer> cells = new ArrayList<>();
        for (int i = 0; i < width * height; i++) cells.add(firstCell + i);
        return new StationLayout(Map.of(Port.RESULT, List.of(result), Port.INGREDIENT, cells), width, height);
    }

    /** A one-input machine; {@code fuel} is -1 when it has no fuel slot. */
    public static StationLayout processor(int input, int fuel, int result) {
        Map<Port, List<Integer>> slots = new EnumMap<>(Port.class);
        slots.put(Port.INGREDIENT, List.of(input));
        if (fuel >= 0) slots.put(Port.FUEL, List.of(fuel));
        slots.put(Port.RESULT, List.of(result));
        return new StationLayout(slots, 0, 0);
    }

    public List<Integer> slots(Port port) { return slots.getOrDefault(port, List.of()); }

    /** The single slot of a port, or -1 when it has none. */
    public int slot(Port port) {
        List<Integer> list = slots(port);
        return list.isEmpty() ? -1 : list.getFirst();
    }

    public boolean isGrid() { return gridWidth * gridHeight > 0; }
}
