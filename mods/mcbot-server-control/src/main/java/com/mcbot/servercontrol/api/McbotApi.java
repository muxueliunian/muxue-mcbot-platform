package com.mcbot.servercontrol.api;

import java.util.*;
import java.util.regex.Pattern;
import net.neoforged.fml.ModList;

/**
 * Entry point for add-on mods that teach MCBOT about another mod's blocks, menus and right-click interactions.
 *
 * <p>Register from the add-on's mod constructor (or common setup). The registry is frozen when a server starts;
 * later registrations are refused. Adapters must pin the exact versions they were tested against
 * ({@link #versionsMatch}) and answer {@code false} from {@code installed()} otherwise: anything not explicitly
 * supported stays refused. A registered adapter whose methods throw is treated as absent for that call.</p>
 */
public final class McbotApi {
    public static final int API_VERSION = 1;
    public static final String MINECRAFT = "1.21.1", NEOFORGE = "21.1.217";
    private static final Pattern ID = Pattern.compile("[a-z0-9_.-]+:[a-z0-9_./-]+");
    private static final List<ContainerAdapter> CONTAINERS = new ArrayList<>();
    private static final List<ItemInteraction> INTERACTIONS = new ArrayList<>();
    private static final List<PickupSink> PICKUP_SINKS = new ArrayList<>();
    private static final Set<String> IDS = new HashSet<>();
    private static boolean frozen;

    private McbotApi() {}

    public static synchronized void registerContainer(ContainerAdapter adapter) {
        String id = checkId(Objects.requireNonNull(adapter, "adapter").id());
        CONTAINERS.add(adapter);
        IDS.add(id);
    }

    public static synchronized void registerInteraction(ItemInteraction interaction) {
        String id = checkId(Objects.requireNonNull(interaction, "interaction").id());
        String kind = interaction.kind();
        if (!ItemInteraction.BLOCK.equals(kind) && !ItemInteraction.ITEM.equals(kind)) throw new IllegalArgumentException("Unknown interaction kind: " + kind);
        INTERACTIONS.add(interaction);
        IDS.add(id);
    }

    public static synchronized void registerPickupSink(PickupSink sink) {
        String id = checkId(Objects.requireNonNull(sink, "sink").id());
        PICKUP_SINKS.add(sink);
        IDS.add(id);
    }

    private static String checkId(String id) {
        if (frozen) throw new IllegalStateException("MCBOT adapter registry is frozen; register from the mod constructor or common setup");
        if (id == null || !ID.matcher(id).matches()) throw new IllegalArgumentException("Adapter id must look like namespace:path, got " + id);
        if (IDS.contains(id)) throw new IllegalArgumentException("Adapter id already registered: " + id);
        return id;
    }

    /** Installed version of a mod, or "" when it is absent. */
    public static String modVersion(String modId) {
        ModList list = ModList.get();
        return list == null ? "" : list.getModContainerById(modId).map(c -> c.getModInfo().getVersion().toString()).orElse("");
    }

    /** True only when the mod has exactly this version and the game and loader are the pinned platform versions. */
    public static boolean versionsMatch(String modId, String version) {
        return version.equals(modVersion(modId)) && MINECRAFT.equals(modVersion("minecraft")) && NEOFORGE.equals(modVersion("neoforge"));
    }

    /** Thrown from {@link ItemInteraction#precondition}; the code reaches the agent (INTERACTION_NOT_READY or UNSUPPORTED). */
    public static final class Refused extends RuntimeException {
        public final String code;
        public Refused(String code, String message) { super(message); this.code = code; }
    }

    public static Refused refuse(String code, String message) { return new Refused(code, message); }

    /** Snapshot of what add-ons registered. Internal: called by MCBOT when a server starts. */
    public static synchronized Registered freeze() {
        frozen = true;
        return new Registered(List.copyOf(CONTAINERS), List.copyOf(INTERACTIONS), List.copyOf(PICKUP_SINKS));
    }

    public record Registered(List<ContainerAdapter> containers, List<ItemInteraction> interactions, List<PickupSink> pickupSinks) {}
}
