package com.mcbot.addon.yessteve;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** The YSM commands this add-on runs, built from checked text only, and the models a server offers. */
final class YsmCommands {
    static final String MOD = "yes_steve_model", VERSION = "2.6.5-neoforge+mc1.21.1";
    private static final Pattern PLAYER = Pattern.compile("[A-Za-z0-9_]{1,16}");
    private static final Pattern ANIMATION = Pattern.compile("[A-Za-z0-9_.:-]{1,64}");

    private YsmCommands() {}

    /**
     * Models in YSM's {@code custom} folder, by the id YSM gives them: a single {@code .ysm} file keeps its extension
     * (verified with 2.6.5), a model folder is its folder name. Zip models and YSM's built-in models are not listed yet.
     */
    static List<String> models(Path custom) {
        List<String> models = new ArrayList<>();
        if (!Files.isDirectory(custom)) return models;
        try (Stream<Path> entries = Files.list(custom)) {
            entries.forEach(entry -> {
                String name = entry.getFileName().toString();
                boolean file = Files.isRegularFile(entry) && name.endsWith(".ysm"), folder = Files.isDirectory(entry);
                if ((file || folder) && quotable(name)) models.add(name);
            });
        } catch (IOException unreadable) {
            return List.of();
        }
        models.sort(null);
        return models;
    }

    /** Fits inside a brigadier quoted string without escapes. */
    static boolean quotable(String text) {
        return !text.isEmpty() && text.length() <= 128 && text.chars().noneMatch(c -> c == '"' || c == '\\' || c < 32 || c == 127);
    }

    static boolean animation(String name) { return ANIMATION.matcher(name).matches(); }

    /** {@code -} keeps the model's default texture; {@code true} skips YSM's per-player model authorisation. */
    static String modelSet(String player, String model) {
        if (!PLAYER.matcher(player).matches() || !quotable(model)) throw new IllegalArgumentException("unsafe model command");
        return "ysm model set " + player + " \"" + model + "\" - true";
    }

    static String play(String player, String animation) {
        if (!PLAYER.matcher(player).matches() || !animation(animation)) throw new IllegalArgumentException("unsafe play command");
        return "ysm play " + player + " " + animation;
    }
}