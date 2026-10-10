package com.mcbot.addon.yessteve;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Plain checks of the command text and model listing; run with {@code gradlew adapterTest}. */
public final class YsmCommandsTest {
    public static void main(String[] args) throws Exception {
        check(YsmCommands.modelSet("Claude", "ds_whale.ysm").equals("ysm model set Claude \"ds_whale.ysm\" - true"), "model command");
        check(YsmCommands.play("Claude", "extra6").equals("ysm play Claude extra6"), "play command");
        refused(() -> YsmCommands.modelSet("Claude", "a\" run op x"), "quote in model");
        refused(() -> YsmCommands.play("Claude", "idle; op x"), "space in animation");
        refused(() -> YsmCommands.play("bad name", "idle"), "space in player");
        check(!YsmCommands.quotable("bad\"name.ysm") && !YsmCommands.quotable("back\\slash"), "quotable");
        Path dir = Files.createTempDirectory("ysm-custom");
        try {
            Files.writeString(dir.resolve("ds_whale.ysm"), "x");
            Files.createDirectory(dir.resolve("claude_orange"));
            Files.writeString(dir.resolve("notes.txt"), "x");
            check(YsmCommands.models(dir).equals(List.of("claude_orange", "ds_whale.ysm")), "models " + YsmCommands.models(dir));
            check(YsmCommands.models(dir.resolve("missing")).isEmpty(), "missing folder");
        } finally {
            try (var files = Files.walk(dir)) { files.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); }
        }
        check(McbotYesSteveModel.HINT.length()<=com.mcbot.servercontrol.api.McbotApi.HINT_MAX&&McbotYesSteveModel.HINT.chars().noneMatch(Character::isISOControl),"usage hint fits the core limit as plain text");
        System.out.println("YsmCommandsTest passed");
    }
    private static void refused(Runnable action, String name) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("not refused: " + name);
    }
    private static void check(boolean ok, String name) { if (!ok) throw new AssertionError(name); }
}