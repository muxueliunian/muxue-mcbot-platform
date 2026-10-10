package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.*;
import java.nio.file.*;
import java.util.*;
import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/** Offline checks of the R5 adapter registry, dispatch safety and JSON interaction declarations; no Minecraft launch. */
final class ModAdaptersTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void rejects(String json,String fragment){
        checks++;
        try { JsonInteractions.parse(JsonParser.parseString(json).getAsJsonObject());throw new AssertionError("Expected rejection: "+fragment); }
        catch(IllegalArgumentException expected){ if(!expected.getMessage().contains(fragment)) throw new AssertionError("Wrong rejection for "+fragment+": "+expected.getMessage()); }
    }
    private static boolean hintRefused(String id,String text){
        try { McbotApi.registerHint(id,text);return false; } catch(IllegalArgumentException refused) { return true; }
    }
    private static boolean hintRefusedFrozen(String id,String text){
        try { McbotApi.registerHint(id,text);return false; } catch(IllegalStateException frozen) { return true; }
    }
    private record FakeSeat(String id,boolean answer,boolean throwing) implements SeatAdapter {
        public boolean installed() {return true;}
        public boolean seat(BlockState state) {if(throwing)throw new IllegalStateException("broken");return answer;}
        public boolean occupied(net.minecraft.server.level.ServerLevel level,net.minecraft.core.BlockPos position) {return false;}
        public boolean seatEntity(net.minecraft.world.entity.Entity entity) {return answer;}
    }
    private record FakeContainer(String id,boolean installed) implements ContainerAdapter {
        public boolean block(BlockState state){return false;}
        public boolean menu(AbstractContainerMenu menu){return false;}
        public Container storage(AbstractContainerMenu menu,Inventory inventory){return null;}
    }
    private record FakeInteraction(String id,String kind) implements ItemInteraction {
        public boolean installed(){return true;} public boolean emptyHand(){return false;} public boolean accepts(ItemStack held){return true;}
        public Expected expected(){return new Expected(0,0,false,Set.of(),Set.of(),Set.of(),false);}
    }
    private static String preconditionCode(RuntimeException thrown){
        ItemInteraction refusing=new ItemInteraction(){
            public String id(){return "example:refusing";} public String kind(){return BLOCK;} public boolean installed(){return true;} public boolean emptyHand(){return false;}
            public boolean accepts(ItemStack held){return true;} public Expected expected(){return null;}
            public void precondition(net.minecraft.server.level.ServerPlayer p,net.minecraft.core.BlockPos b,BlockState s,ItemStack h){throw thrown;}
        };
        try { ItemInteractions.precondition(refusing,null,null,null,null);return "passed"; } catch(Protocol.Error e) { return e.code; }
    }
    private static final String POT="""
        {"id":"examplecook:pot/add_oil","note":"pour oil into an idle pot","requires":{"examplecook":"1.2.3"},
         "blocks":["examplecook:pot"],"held":["examplecook:oil_bottle","#c:oils"],"consume":[1,1],
         "changes":["has_oil"],"gains":["minecraft:glass_bottle"],"refuseWhen":{"has_oil":["true"],"lit":["false"]}}""";

    static void run() throws Exception {
        // JSON declarations: strict, version-pinned, fail closed
        JsonInteractions.Rule pot=JsonInteractions.parse(JsonParser.parseString(POT).getAsJsonObject());
        check(pot.matchesBlock("examplecook:pot")&&!pot.matchesBlock("examplecook:pan"),"only listed blocks match");
        check(pot.acceptsItem("examplecook:oil_bottle",tag->false),"listed item accepted");
        check(pot.acceptsItem("other:olive_oil",tag->tag.equals("c:oils")),"item in a listed tag accepted");
        check(!pot.acceptsItem("minecraft:water_bucket",tag->false),"other items refused");
        check(pot.refusal(Map.of("has_oil","false","lit","true"))==null,"ready pot passes");
        check(pot.refusal(Map.of("has_oil","true","lit","true")).contains("has_oil"),"declared not-ready value refuses");
        check(pot.refusal(Map.of("lit","true")).contains("no property has_oil"),"missing property refuses (fail closed)");
        var expected=pot.expected();
        check(expected.minConsumed()==1&&expected.maxConsumed()==1&&expected.properties().equals(Set.of("has_oil"))&&expected.gainedItems().equals(Set.of("minecraft:glass_bottle"))&&!expected.opensMenu(),"envelope built from declaration");
        check(JsonInteractions.parse(JsonParser.parseString("{\"id\":\"minecraft:cauldron/fill\",\"blocks\":[\"minecraft:cauldron\"],\"held\":[\"minecraft:water_bucket\"],\"consume\":[0,0],\"changes\":[\"level\"]}").getAsJsonObject()).requires().isEmpty(),
            "vanilla declarations need no requires");
        rejects(POT.replace("\"note\"","\"notes\""),"unknown key");
        rejects(POT.replace("\"requires\":{\"examplecook\":\"1.2.3\"},",""),"must be listed in requires");
        rejects(POT.replace("\"examplecook\":\"1.2.3\"","\"other\":\"1.0\""),"must be listed in requires");
        rejects(POT.replace("\"1.2.3\"","\"\""),"exact version");
        rejects(POT.replace("\"blocks\":[\"examplecook:pot\"],","\"blocks\":[],"),"must not be empty");
        rejects(POT.replace("\"held\":[\"examplecook:oil_bottle\",\"#c:oils\"],",""),"held must list");
        rejects(POT.replace("\"held\":","\"emptyHand\":true,\"held\":"),"cannot list held");
        rejects(POT.replace("[1,1]","[2,1]"),"greater than max");
        rejects(POT.replace("[1,1]","[1,65]"),"0..64");
        rejects(POT.replace("[1,1]","[1]"),"consume must be");
        rejects(POT.replace("examplecook:pot\"]","Example:Pot\"]"),"bad id");
        rejects("{\"id\":\"minecraft:x\",\"blocks\":[\"minecraft:stone\"],\"held\":[\"minecraft:stick\"],\"consume\":[0,0]}","no possible effect");
        rejects("{\"id\":\"minecraft:x\",\"blocks\":[\"minecraft:stone\"],\"emptyHand\":true,\"consume\":[0,1],\"changes\":[\"a\"]}","empty hand cannot consume");
        List<String> problems=new ArrayList<>();
        check(JsonInteractions.parseFile("two.json","["+POT+","+POT.replace("add_oil","add_salt")+"]",problems).size()==2&&problems.isEmpty(),"a file may hold an array of declarations");
        check(JsonInteractions.parseFile("bad.json","["+POT+",{\"id\":\"x\"}]",problems).isEmpty()&&problems.getFirst().contains("bad.json")&&problems.getFirst().contains("entry 1"),
            "one broken entry skips the whole file and names it");
        problems.clear();
        check(JsonInteractions.parseFile("junk.json","{not json",problems).isEmpty()&&problems.size()==1,"malformed JSON is reported, not thrown");

        Path dir=Files.createTempDirectory("mcbot-adapters");
        try {
            problems.clear();
            check(JsonInteractions.loadDirectory(dir.resolve("interactions"),problems).isEmpty()&&problems.isEmpty(),"no interactions directory is fine");
            Files.createDirectories(dir.resolve("interactions"));
            Files.writeString(dir.resolve("interactions/pot.json"),POT);
            Files.writeString(dir.resolve("interactions/readme.txt"),"ignored");
            List<ItemInteraction> loaded=JsonInteractions.loadDirectory(dir.resolve("interactions"),problems);
            check(loaded.size()==1&&loaded.getFirst().id().equals("examplecook:pot/add_oil")&&loaded.getFirst().kind().equals(ItemInteraction.BLOCK)&&problems.isEmpty(),"*.json files load as block interactions");
        } finally {
            try(var files=Files.walk(dir)) { for(Path p:files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p); }
        }

        // Combining built-ins, JSON and add-ons: first id wins, broken adapters skipped, absent mods hidden
        ContainerAdapter brokenId=new ContainerAdapter(){
            public String id(){throw new IllegalStateException("broken");} public boolean installed(){return true;}
            public boolean block(BlockState s){return false;} public boolean menu(AbstractContainerMenu m){return false;} public Container storage(AbstractContainerMenu m,Inventory i){return null;}
        };
        ContainerAdapter brokenInstall=new ContainerAdapter(){
            public String id(){return "example:crate";} public boolean installed(){throw new LinkageError("changed");}
            public boolean block(BlockState s){return false;} public boolean menu(AbstractContainerMenu m){return false;} public Container storage(AbstractContainerMenu m,Inventory i){return null;}
        };
        problems=new ArrayList<>();
        var combined=ModAdapters.combine(List.of(new FakeContainer("example:builtin",true)),
            List.of(new FakeContainer("example:builtin",true),new FakeContainer("example:absent",false),brokenId,brokenInstall,new FakeContainer("example:chest",true)),
            List.of(ItemInteractions.COMPOSTER),List.of(new FakeInteraction("minecraft:composter/add","block"),new FakeInteraction("examplecook:pot/add_oil","block")),
            List.of(new FakeInteraction("examplecook:pot/add_oil","block"),new FakeInteraction("example:backpack/open","item")),problems);
        check(combined.containers().stream().map(ContainerAdapter::id).toList().equals(List.of("example:builtin","example:chest")),"installed containers only, built-in kept on duplicate");
        check(combined.interactions().size()==3&&combined.interactions().getFirst()==ItemInteractions.COMPOSTER,"built-in composter wins over a JSON redefinition; add-on duplicate dropped");
        check(problems.stream().filter(p->p.startsWith("duplicate")).count()==3&&problems.stream().anyMatch(p->p.contains("broken id")),"every skipped adapter is reported");

        // Add-on failures never pass: refusal codes are limited, exceptions become UNSUPPORTED or an unknown receipt
        check(preconditionCode(McbotApi.refuse("INTERACTION_NOT_READY","cold")).equals("INTERACTION_NOT_READY"),"add-on not-ready refusal keeps its code");
        check(preconditionCode(McbotApi.refuse("FORBIDDEN","x")).equals("INTERACTION_NOT_READY"),"an add-on cannot invent other protocol codes");
        check(preconditionCode(new IllegalStateException("bug")).equals("UNSUPPORTED"),"a crashing precondition refuses the interaction");
        ItemInteraction summaryFails=new ItemInteraction(){
            public String id(){return "example:s";} public String kind(){return BLOCK;} public boolean installed(){return true;} public boolean emptyHand(){return false;}
            public boolean accepts(ItemStack held){throw new IllegalStateException("bug");} public Expected expected(){return null;}
            public JsonObject summary(net.minecraft.server.level.ServerPlayer p,net.minecraft.core.BlockPos b){throw new IllegalStateException("bug");}
            public boolean consistent(JsonObject a,JsonObject b){throw new IllegalStateException("bug");}
        };
        boolean refusedBefore=false;
        try { ItemInteractions.summary(summaryFails,null,null,false); } catch(Protocol.Error e) { refusedBefore=e.code.equals("UNSUPPORTED"); }
        check(refusedBefore,"a summary failure before the native call refuses");
        check(ItemInteractions.summary(summaryFails,null,null,true).has("adapterError"),"a summary failure after the native call is recorded so the receipt becomes unknown");
        check(!ItemInteractions.consistent(summaryFails,new JsonObject(),new JsonObject()),"a crashing value check never confirms success");
        // Per-use envelopes: defaults to expected(), may depend on the summary before the click, a crash gives no envelope
        ItemInteraction.Expected dish=new ItemInteraction.Expected(1,1,false,Set.of(),Set.of(),Set.of("example:dish"),false);
        ItemInteraction perUse=new ItemInteraction(){
            public String id(){return "example:pot/take_out";} public String kind(){return BLOCK;} public boolean installed(){return true;} public boolean emptyHand(){return false;}
            public boolean accepts(ItemStack held){return true;} public Expected expected(){return new Expected(0,0,false,Set.of(),Set.of(),Set.of(),false);}
            public Expected expectedFor(JsonObject before){ if(!before.has("result")) throw new IllegalStateException("no dish");
                return new Expected(1,1,false,Set.of(),Set.of(),Set.of(before.get("result").getAsString()),false); }
        };
        JsonObject withDish=new JsonObject();withDish.addProperty("result","example:dish");
        check(ItemInteractions.expected(perUse,withDish).equals(dish),"envelope built from the summary before the click");
        check(ItemInteractions.expected(perUse,new JsonObject())==null,"an adapter that cannot state its envelope gives none (receipt becomes unknown)");
        check(ItemInteractions.expected(new FakeInteraction("example:plain","block"),null).maxConsumed()==0,"default expectedFor falls back to expected()");

        // Public registration API: validated ids, no duplicates, frozen when a server starts
        McbotApi.registerContainer(new FakeContainer("testmod:crate",true));
        McbotApi.registerInteraction(new FakeInteraction("testmod:crate/open","item"));
        boolean refused=false;
        try { McbotApi.registerContainer(new FakeContainer("testmod:crate",true)); } catch(IllegalArgumentException duplicate) { refused=true; }
        check(refused,"duplicate add-on id refused at registration");
        refused=false;
        try { McbotApi.registerInteraction(new FakeInteraction("testmod:x","sideways")); } catch(IllegalArgumentException kind) { refused=true; }
        check(refused,"unknown interaction kind refused");
        refused=false;
        try { McbotApi.registerContainer(new FakeContainer("No Namespace",true)); } catch(IllegalArgumentException bad) { refused=true; }
        check(refused,"id without namespace refused");
        // Usage hints: same id rules, one per namespace, plain bounded text, frozen with the rest
        McbotApi.registerHint("testmod:hint","Open the crate with open-container.\n\tThen\u0007 take items.\u202e");
        McbotApi.registerHint("ghost:hint","describes a mod that is not installed");
        check(hintRefused("testmod:hint","again"),"a hint id cannot be registered twice");
        check(hintRefused("testmod:other","second note for the same namespace"),"one hint per namespace");
        check(hintRefused("testmod:crate","x"),"a hint cannot reuse an adapter id");
        check(hintRefused("No Namespace","x")&&hintRefused(null,"x"),"a hint id needs namespace:path");
        check(hintRefused("long:hint","a".repeat(McbotApi.HINT_MAX+1)),"text over the limit refused");
        McbotApi.registerHint("edge:hint","b".repeat(McbotApi.HINT_MAX)+"\n\n");
        check(hintRefused("blank:hint"," \n\t\u0000 "),"text that is only control characters and spaces is refused");
        boolean nullText=false;
        try { McbotApi.registerHint("null:hint",null); } catch(NullPointerException missing) { nullText=true; }
        check(nullText,"null text refused");
        // Seats: same id rules; dispatch by the adapter that says yes; one that throws is no match
        McbotApi.registerSeat(new FakeSeat("testmod:seat",true,false));
        boolean seatDuplicate=false;
        try { McbotApi.registerSeat(new FakeSeat("testmod:seat",true,false)); } catch(IllegalArgumentException duplicate) { seatDuplicate=true; }
        check(seatDuplicate,"a seat id cannot be registered twice");
        McbotApi.Registered registered=McbotApi.freeze();
        check(registered.containers().size()==1&&registered.interactions().size()==1,"freeze returns what add-ons registered");
        check(registered.seats().size()==1&&new McbotApi.Registered(List.of(),List.of(),List.of(),List.of(),List.of(),List.of(),List.of()).seats().isEmpty(),"freeze returns the registered seats; the older shapes have none");
        SeatAdapter yes=new FakeSeat("a:yes",true,false),brokenSeat=new FakeSeat("b:broken",true,true);
        check(ModAdapters.seat(List.of(new FakeSeat("a:no",false,false),yes),null)==yes&&ModAdapters.seat(List.of(brokenSeat,yes),null)==yes&&ModAdapters.seat(List.of(brokenSeat),null)==null&&ModAdapters.seat(List.of(),null)==null,"seat dispatch: first adapter that says yes; one that throws is skipped; none gives null");
        check(!ModAdapters.seatEntity(List.of(yes),null),"no entity is never a seat entity");
        check(registered.hints().equals(List.of(new McbotApi.Hint("testmod:hint","Open the crate with open-container. Then take items."),
            new McbotApi.Hint("ghost:hint","describes a mod that is not installed"),new McbotApi.Hint("edge:hint","b".repeat(McbotApi.HINT_MAX)))),
            "hints are kept in order with control and format characters turned into single spaces");
        check(new McbotApi.Registered(List.of(),List.of(),List.of(),List.of(),List.of(),List.of()).hints().isEmpty(),"the old Registered shape still builds, without hints");
        check(hintRefusedFrozen("late:hint","x"),"hint registration after server start is refused");
        check(ModAdapters.liveHints(registered.hints(),Set.of("testmod","edge")).stream().map(McbotApi.Hint::id).toList().equals(List.of("testmod:hint","edge:hint")),
            "only hints whose namespace has something installed are kept");
        JsonArray hello=ModAdapters.hintsJson(registered.hints(),Set.of("testmod"));
        check(hello.size()==1&&hello.get(0).getAsJsonObject().get("id").getAsString().equals("testmod:hint")
            &&hello.get(0).getAsJsonObject().get("text").getAsString().equals("Open the crate with open-container. Then take items.")
            &&hello.get(0).getAsJsonObject().size()==2,"hello hints are [{id, text}] for live namespaces; ghost and edge have nothing installed");
        check(ModAdapters.hintsJson(List.of(),Set.of("testmod")).isEmpty(),"no hints registered gives an empty hello list");
        refused=false;
        try { McbotApi.registerContainer(new FakeContainer("testmod:late",true)); } catch(IllegalStateException frozen) { refused=true; }
        check(refused,"registration after server start is refused");
        check(McbotApi.refuse("INTERACTION_NOT_READY","pot is cold").code.equals("INTERACTION_NOT_READY"),"refusal carries its code");
        // Pickup sinks: only an exact single-item growth in one sink accounts for absorbed items
        Map<String,Map<String,Integer>> before=Map.of("sb:backpack",Map.of("minecraft:cobblestone",3)),
            exact=Map.of("sb:backpack",Map.of("minecraft:cobblestone",7));
        check("sb:backpack".equals(ModAdapters.absorbedBy(before,exact,"minecraft:cobblestone",4)),"exact growth of the absorbed item is attributed to its sink");
        check(ModAdapters.absorbedBy(before,exact,"minecraft:cobblestone",3)==null,"a different count is not attributed");
        check(ModAdapters.absorbedBy(before,exact,"minecraft:dirt",4)==null,"growth of another item is not attributed");
        check(ModAdapters.absorbedBy(before,Map.of("sb:backpack",Map.of("minecraft:cobblestone",7,"minecraft:dirt",1)),"minecraft:cobblestone",4)==null,"any extra change voids the attribution");
        check(ModAdapters.absorbedBy(Map.of("a:x",Map.of(),"b:y",Map.of()),Map.of("a:x",Map.of("minecraft:stone",2),"b:y",Map.of("minecraft:stone",2)),"minecraft:stone",4)==null,"a split across sinks is not attributed");
        check("b:y".equals(ModAdapters.absorbedBy(Map.of("a:x",Map.of(),"b:y",Map.of()),Map.of("a:x",Map.of(),"b:y",Map.of("minecraft:stone",4)),"minecraft:stone",4)),"the one sink that grew is named");
        check(ModAdapters.absorbedBy(null,exact,"minecraft:cobblestone",4)==null&&ModAdapters.absorbedBy(before,null,"minecraft:cobblestone",4)==null,"an unreadable sink attributes nothing");
        check(ModAdapters.absorbedBy(Map.of(),Map.of(),"minecraft:cobblestone",4)==null,"without sinks nothing is attributed");
        check(ModAdapters.absorbedBy(before,Map.of("other:sink",Map.of("minecraft:cobblestone",7)),"minecraft:cobblestone",4)==null,"a changed sink set attributes nothing");
        PickupSink broken=new PickupSink(){public String id(){return "broken:sink";}public boolean installed(){throw new IllegalStateException();}public Map<String,Integer> stored(net.minecraft.server.level.ServerPlayer p){return Map.of();}};
        PickupSink absent=new PickupSink(){public String id(){return "absent:sink";}public boolean installed(){return false;}public Map<String,Integer> stored(net.minecraft.server.level.ServerPlayer p){return Map.of();}};
        PickupSink live=new PickupSink(){public String id(){return "live:sink";}public boolean installed(){return true;}public Map<String,Integer> stored(net.minecraft.server.level.ServerPlayer p){return Map.of();}};
        check(ModAdapters.installedSinks(List.of(broken,absent,live)).equals(List.of(live)),"only installed sinks are used; a throwing installed() counts as absent");
        // Emote and appearance sources: installed ones with an unused id, the rest absent or reported
        record Source(String id,boolean on){}
        List<String> sourceProblems=new ArrayList<>();
        Set<String> taken=new HashSet<>(Set.of("testmod:crate"));
        List<Source> kept=ModAdapters.installedUnique(List.of(new Source("ysm:animation",true),new Source("off:animation",false),new Source("ysm:animation",true),new Source("testmod:crate",true)),
            Source::id,Source::on,taken,sourceProblems,"emote source");
        check(kept.equals(List.of(new Source("ysm:animation",true))),"only installed sources with a fresh id are used");
        check(sourceProblems.size()==2&&sourceProblems.stream().allMatch(p->p.startsWith("duplicate adapter id")),"a repeated id or one taken by another adapter is reported");
        check(ModAdapters.installedUnique(List.of(new Source(null,true)),s->{throw new IllegalStateException();},Source::on,new HashSet<>(),sourceProblems,"appearance source").isEmpty()&&sourceProblems.get(2).contains("broken id"),"a throwing id() is skipped and reported");
        check(BodyEmotes.GESTURES.containsAll(List.of("wave","nod","shake","crouch","jump","spin")),"built-in gestures are the vanilla ones");

        System.out.println("ModAdaptersTest: "+checks+" checks passed (registry, dispatch merge, JSON declarations; no Minecraft launch)");
    }
}
