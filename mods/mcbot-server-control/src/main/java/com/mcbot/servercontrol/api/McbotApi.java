package com.mcbot.servercontrol.api;

import java.util.*;
import java.util.regex.Pattern;
import com.mcbot.servercontrol.api.workstation.WorkstationAdapter;
import com.mcbot.servercontrol.platform.LoaderPlatform;

/**
 * Entry point for add-on mods that teach MCBOT about another mod's blocks, menus and right-click interactions.
 *
 * <p>Register from the add-on's mod constructor (or common setup). The registry is frozen when a server starts;
 * later registrations are refused. Adapters must pin the exact versions of the adapted mod they were tested against
 * ({@link #versionsMatch}; the loader only needs to be a supported build, {@link #NEOFORGE} or a later 21.1 one)
 * and answer {@code false} from {@code installed()} otherwise: anything not explicitly
 * supported stays refused. A registered adapter whose methods throw is treated as absent for that call.</p>
 */
public final class McbotApi {
    public static final int API_VERSION = 1;
    public static final String MINECRAFT = "1.21.1", NEOFORGE = "21.1.217";
    private static final Pattern ID = Pattern.compile("[a-z0-9_.-]+:[a-z0-9_./-]+");
    private static final List<ContainerAdapter> CONTAINERS = new ArrayList<>();
    private static final List<ItemInteraction> INTERACTIONS = new ArrayList<>();
    private static final List<PickupSink> PICKUP_SINKS = new ArrayList<>();
    private static final List<WorkstationAdapter> WORKSTATIONS = new ArrayList<>();
    private static final List<EmoteSource> EMOTES = new ArrayList<>();
    private static final List<AppearanceSource> APPEARANCES = new ArrayList<>();
    private static final List<Hint> HINTS = new ArrayList<>();
    private static final Set<String> HINT_NAMESPACES = new HashSet<>();
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

    /** A workstation (crafting grid, machine) for craft-item, smelt-item and later workstation tools; see {@link WorkstationAdapter}. */
    public static synchronized void registerWorkstation(WorkstationAdapter adapter) {
        String id = checkId(Objects.requireNonNull(adapter, "adapter").id());
        Objects.requireNonNull(adapter.template(), "template");
        WORKSTATIONS.add(adapter);
        IDS.add(id);
    }

    /** Animations the agent can play with the emote action; see {@link EmoteSource}. */
    public static synchronized void registerEmotes(EmoteSource source) {
        String id = checkId(Objects.requireNonNull(source, "source").id());
        EMOTES.add(source);
        IDS.add(id);
    }

    /** Looks the hosting person can pick for the body; see {@link AppearanceSource}. */
    public static synchronized void registerAppearance(AppearanceSource source) {
        String id = checkId(Objects.requireNonNull(source, "source").id());
        APPEARANCES.add(source);
        IDS.add(id);
    }

    /** Longest hint text, after control characters are removed. */
    public static final int HINT_MAX = 600;

    /**
     * A short usage note for the agent about this add-on's tools, sent in {@code hello.hints} while something the add-on
     * registered under the same namespace is installed. One per namespace. Plain text: control characters become spaces;
     * at most {@link #HINT_MAX} characters. The runtime only passes it on for official plugins the hosting person left
     * enabled, as extra description of tools that already exist; it can never add tools or permissions.
     */
    public static synchronized void registerHint(String id, String text) {
        checkId(id);
        if (HINT_NAMESPACES.contains(namespace(id))) throw new IllegalArgumentException("A hint is already registered for namespace " + namespace(id));
        String clean = hintText(Objects.requireNonNull(text, "text"));
        if (clean.isEmpty()) throw new IllegalArgumentException("Hint text is empty");
        if (clean.length() > HINT_MAX) throw new IllegalArgumentException("Hint text longer than " + HINT_MAX + " characters: " + clean.length());
        HINTS.add(new Hint(id, clean));
        HINT_NAMESPACES.add(namespace(id));
        IDS.add(id);
    }

    /** Control characters (line breaks included) become single spaces; leading and trailing space is dropped. */
    static String hintText(String text) {
        StringBuilder out = new StringBuilder(text.length());
        text.codePoints().forEach(c -> out.appendCodePoint(Character.isISOControl(c) || Character.getType(c) == Character.FORMAT ? ' ' : c));
        return out.toString().replaceAll(" {2,}", " ").strip();
    }

    static String namespace(String id) { return id.substring(0, id.indexOf(':')); }

    /** A registered usage note; see {@link #registerHint}. */
    public record Hint(String id, String text) {}

    private static String checkId(String id) {
        if (frozen) throw new IllegalStateException("MCBOT adapter registry is frozen; register from the mod constructor or common setup");
        if (id == null || !ID.matcher(id).matches()) throw new IllegalArgumentException("Adapter id must look like namespace:path, got " + id);
        if (IDS.contains(id)) throw new IllegalArgumentException("Adapter id already registered: " + id);
        return id;
    }

    /** Lowest supported loader build by loader name; a loader not listed here is not supported. */
    private static final Map<String, String> LOADERS = Map.of("neoforge", NEOFORGE);

    /** Installed version of a mod, or "" when it is absent (or the loader is not up yet). */
    public static String modVersion(String modId) {
        LoaderPlatform platform = LoaderPlatform.installedOrNull();
        return platform == null ? "" : platform.modVersion(modId);
    }

    /** True when the game is the pinned version and the running loader is a build of the same line at or above the lowest supported one. */
    public static boolean platformMatches() {
        LoaderPlatform platform = LoaderPlatform.installedOrNull();
        if (platform == null || !MINECRAFT.equals(platform.modVersion("minecraft"))) return false;
        String lowest = LOADERS.get(platform.loader());
        return lowest != null && sameLineAtLeast(platform.modVersion(platform.loaderModId()), lowest);
    }

    /** "21.1.229" and "21.1.229-beta" are at least "21.1.217"; "21.2.5" and "21.1.200" are not. */
    static boolean sameLineAtLeast(String version, String lowest) {
        int cut = lowest.lastIndexOf('.');
        String line = lowest.substring(0, cut + 1);
        if (version == null || !version.startsWith(line)) return false;
        String rest = version.substring(line.length());
        int digits = 0;
        while (digits < rest.length() && Character.isDigit(rest.charAt(digits))) digits++;
        if (digits == 0 || digits > 9) return false;
        return Integer.parseInt(rest.substring(0, digits)) >= Integer.parseInt(lowest.substring(cut + 1));
    }

    /** True only when the mod has exactly this version, the game is the pinned version and the loader is a supported build. */
    public static boolean versionsMatch(String modId, String version) {
        return version.equals(modVersion(modId)) && platformMatches();
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
        return new Registered(List.copyOf(CONTAINERS), List.copyOf(INTERACTIONS), List.copyOf(PICKUP_SINKS), List.copyOf(WORKSTATIONS), List.copyOf(EMOTES), List.copyOf(APPEARANCES), List.copyOf(HINTS));
    }

    public record Registered(List<ContainerAdapter> containers, List<ItemInteraction> interactions, List<PickupSink> pickupSinks, List<WorkstationAdapter> workstations, List<EmoteSource> emotes, List<AppearanceSource> appearances, List<Hint> hints) {
        /** The shape before hints existed. */
        public Registered(List<ContainerAdapter> containers, List<ItemInteraction> interactions, List<PickupSink> pickupSinks, List<WorkstationAdapter> workstations, List<EmoteSource> emotes, List<AppearanceSource> appearances) {
            this(containers, interactions, pickupSinks, workstations, emotes, appearances, List.of());
        }
    }
}
