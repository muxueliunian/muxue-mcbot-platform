package com.mcbot.servercontrol;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import net.minecraft.commands.CommandSource;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

/**
 * Validation only. Integrated servers have no RCON, so a single-player test can drop command.txt into the
 * directory named by -Dmcbot.commandFixture; it runs once as the server and the output lands in reply.txt.
 * Never active on a dedicated server or without the explicit property.
 */
final class CommandFileFixture implements AutoCloseable {
    private final Thread thread;
    private volatile boolean closed;
    private CommandFileFixture(MinecraftServer server,Path directory) {
        thread=new Thread(()->{
            Path command=directory.resolve("command.txt");
            while(!closed) {
                try {
                    if(Files.exists(command)) {
                        String text=Files.readString(command,StandardCharsets.UTF_8).strip();Files.delete(command);
                        // The server task queue keeps running while ticks are paused, so this also works then.
                        server.execute(()->reply(server,directory,text));
                    }
                    Thread.sleep(250);
                } catch(InterruptedException interrupted) {return;}
                catch(Exception failure) {write(directory,"error: "+failure.getClass().getSimpleName());}
            }
        },"mcbot-command-fixture");
        thread.setDaemon(true);
    }
    static CommandFileFixture start(MinecraftServer server) {
        String directory=System.getProperty("mcbot.commandFixture");
        if(directory==null||directory.isBlank()||server.isDedicatedServer())return null;
        CommandFileFixture fixture=new CommandFileFixture(server,Path.of(directory));fixture.thread.start();return fixture;
    }
    private static void reply(MinecraftServer server,Path directory,String text) {
        StringBuilder output=new StringBuilder();
        CommandSource collector=new CommandSource() {
            public void sendSystemMessage(Component message){output.append(message.getString()).append('\n');}
            public boolean acceptsSuccess(){return true;}
            public boolean acceptsFailure(){return true;}
            public boolean shouldInformAdmins(){return false;}
        };
        try {server.getCommands().performPrefixedCommand(server.createCommandSourceStack().withSource(collector),text);}
        catch(RuntimeException failure){output.append("error: ").append(failure.getClass().getSimpleName());}
        write(directory,output.toString());
    }
    private static void write(Path directory,String text) {
        try {
            Path temp=directory.resolve("reply.txt.tmp");Files.writeString(temp,text,StandardCharsets.UTF_8);
            Files.move(temp,directory.resolve("reply.txt"),StandardCopyOption.REPLACE_EXISTING);
        } catch(Exception ignored) {}
    }
    @Override public void close(){closed=true;thread.interrupt();}
}
