package com.mcbot.servercontrol;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.AppearanceSource;
import com.mcbot.servercontrol.api.EmoteSource;
import com.mcbot.servercontrol.api.McbotApi;
import java.util.*;
import java.util.regex.Pattern;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * The emote and set-appearance actions. Built-in gestures are vanilla movements every client sees (an arm swing,
 * head turns, crouching, a jump) played over about a second. Add-on animations ({@link EmoteSource}) start at once and
 * are stopped when their time is up or the body starts another action, because model animations usually loop.
 */
final class BodyEmotes {
    static final List<String> GESTURES=List.of("wave","nod","shake","crouch","jump","spin");
    private static final Pattern NAME=Pattern.compile("[A-Za-z0-9_.:-]{1,64}");
    private static final int GESTURE_TICKS=20;
    private String gesture;
    private int tick;
    private float yaw,pitch;
    private EmoteSource playing;
    private ServerPlayer playingOn;
    private String playingName;
    private long playingUntil;

    /** Starts a built-in gesture (true: tick it until {@link #tickGesture} says done) or plays an add-on animation (false: already finished). */
    boolean begin(ControlSession.Operation operation,ServerPlayer body,long now) {
        JsonObject args=operation.args;
        String name=string(args,"name");
        if(!NAME.matcher(name).matches()) throw error("INVALID_ARGUMENT","Emote names use letters, digits and _ . : - (at most 64)");
        if(!args.has("source")) {
            if(!GESTURES.contains(name)) throw error("INVALID_ARGUMENT","Built-in emotes are "+String.join(", ",GESTURES)+"; name a source for add-on animations");
            stopAnimation();
            gesture=name;tick=0;yaw=body.getYRot();pitch=body.getXRot();
            return true;
        }
        String id=string(args,"source");
        EmoteSource source=ModAdapters.emoteSources().stream().filter(s->id.equals(s.id())).findFirst().orElse(null);
        if(source==null) throw error("UNSUPPORTED","No installed emote source "+id);
        double seconds=bounded(args,"seconds",6,1,30);
        try { if(!source.accepts(name)) throw error("INVALID_ARGUMENT",id+" has no animation "+name); }
        catch(RuntimeException | LinkageError broken) { if(broken instanceof Protocol.Error e)throw e;throw error("UNSUPPORTED","Emote source failed to check the name"); }
        stopAnimation();
        try { source.play(body,name); }
        catch(McbotApi.Refused refused) { throw error(Set.of("INTERACTION_NOT_READY","UNSUPPORTED").contains(refused.code)?refused.code:"UNSUPPORTED",String.valueOf(refused.getMessage())); }
        catch(RuntimeException | LinkageError broken) { throw error("UNSUPPORTED","Emote source failed to play "+name); }
        playing=source;playingOn=body;playingName=name;playingUntil=now+(long)(seconds*1000);
        operation.finish("succeeded","Playing "+name,obj("source",id,"name",name,"seconds",seconds));
        return false;
    }

    /** One tick of the built-in gesture; true when it is over and the pose is restored. */
    boolean tickGesture(BodyPlayer body) {
        int t=tick++;
        double wave=Math.sin(t*Math.PI/5);
        switch(gesture) {
            case "wave" -> { if(t%5==0&&t<=10) body.swing(InteractionHand.MAIN_HAND,true); }
            case "nod" -> body.setXRot(Mth.clamp(pitch+(float)(22*Math.abs(wave)),-90,90));
            case "shake" -> turn(body,yaw+(float)(30*wave));
            case "crouch" -> body.setShiftKeyDown((t/5)%2==0);
            case "jump" -> body.jumpInput(t==0&&body.onGround());
            case "spin" -> turn(body,yaw+Math.min(360,t*30f));
            default -> {}
        }
        if(tick<GESTURE_TICKS) return false;
        cancelGesture(body);
        return true;
    }
    JsonObject gestureResult() {return obj("name",gesture);}
    boolean gesturing() {return gesture!=null;}

    /** Ends a gesture early (the action was stopped) and puts the head and stance back. */
    void cancelGesture(BodyPlayer body) {
        if(gesture==null) return;
        if(body!=null) { body.setShiftKeyDown(false);body.jumpInput(false);turn(body,yaw);body.setXRot(pitch); }
        gesture=null;
    }
    /** Gesture turns go through the one aim entry: a sitting body only turns its head. Pitch is left as it is. */
    private static void turn(BodyPlayer body,float yaw) {NativeSeat.aim(body,yaw,body.getXRot());}

    /** Stops an add-on animation whose time is up. */
    void tick(long now) {if(playing!=null&&now>=playingUntil) stopAnimation();}
    /** Stops any add-on animation now: the body starts something else, or leaves. */
    void stopAnimation() {
        EmoteSource source=playing;ServerPlayer body=playingOn;
        playing=null;playingOn=null;playingName=null;
        if(source==null) return;
        try { source.stop(body); } catch(RuntimeException | LinkageError broken) { /* the next play replaces it anyway */ }
    }
    String playing() {return playingName;}

    /** hello: built-in gestures, installed animation sources and the appearance choices the server owner offers. */
    static void describe(JsonObject hello,MinecraftServer server) {
        JsonObject emotes=new JsonObject();
        JsonArray builtin=new JsonArray();GESTURES.forEach(builtin::add);emotes.add("builtin",builtin);
        JsonArray sources=new JsonArray();
        for(EmoteSource source:ModAdapters.emoteSources()) {
            String hint="";
            try { hint=String.valueOf(source.hint()); } catch(RuntimeException | LinkageError broken) { /* no hint */ }
            sources.add(obj("id",source.id(),"hint",hint));
        }
        emotes.add("sources",sources);
        hello.add("emotes",emotes);
        JsonArray appearances=new JsonArray();
        for(AppearanceSource source:ModAdapters.appearances()) {
            JsonArray choices=new JsonArray();
            for(String choice:choices(source,server)) choices.add(choice);
            appearances.add(obj("id",source.id(),"choices",choices));
        }
        hello.add("appearances",appearances);
    }
    private static List<String> choices(AppearanceSource source,MinecraftServer server) {
        try { List<String> list=source.choices(server);return list==null?List.of():list; }
        catch(RuntimeException | LinkageError broken) { return List.of(); }
    }

    /** set-appearance: one of the choices the source lists right now, applied to the online body. */
    static JsonObject setAppearance(JsonObject args,ServerPlayer body,MinecraftServer server) {
        String id=string(args,"source"),choice=string(args,"choice");
        AppearanceSource source=ModAdapters.appearances().stream().filter(s->id.equals(s.id())).findFirst().orElse(null);
        if(source==null) throw error("UNSUPPORTED","No installed appearance source "+id);
        if(!choices(source,server).contains(choice)) throw error("INVALID_ARGUMENT",id+" does not offer "+choice);
        try { source.apply(body,choice); }
        catch(McbotApi.Refused refused) { throw error("UNSUPPORTED",String.valueOf(refused.getMessage())); }
        catch(RuntimeException | LinkageError broken) { throw error("UNSUPPORTED","Appearance source failed to apply "+choice); }
        return obj("source",id,"choice",choice);
    }
}
