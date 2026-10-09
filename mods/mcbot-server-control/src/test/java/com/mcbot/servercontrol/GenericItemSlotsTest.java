package com.mcbot.servercontrol;

import com.google.gson.JsonParser;
import com.mcbot.servercontrol.api.McbotApi;
import com.mcbot.servercontrol.platform.LoaderPlatform;
import java.nio.file.*;
import java.util.*;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.RecipeType;

/** 8b generic item-handler access without a game: config, dispatch decision, sides and the insert/extract loops. */
final class GenericItemSlotsTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void code(String expected,Runnable action,String message){
        checks++;
        try{action.run();throw new AssertionError(message);}catch(Protocol.Error e){if(!e.code.equals(expected))throw new AssertionError(message+": "+e.code);}
    }
    private static void rejects(String json,String fragment){
        checks++;
        try{GenericItemSlots.parse(JsonParser.parseString(json).getAsJsonObject());throw new AssertionError("accepted: "+json);}
        catch(IllegalArgumentException e){if(!e.getMessage().contains(fragment))throw new AssertionError("wrong rejection for "+json+": "+e.getMessage());}
    }

    record Stack(String id,int count) {}
    static final Stack EMPTY=new Stack("",0);
    static final GenericItemSlots.Stacks<Stack> STACKS=new GenericItemSlots.Stacks<>() {
        public boolean empty(Stack s){return s.count()<=0;}
        public int count(Stack s){return s.count();}
        public Stack copy(Stack s,int n){return n<=0?EMPTY:new Stack(s.id(),n);}
        public boolean same(Stack a,Stack b){return a.id().equals(b.id());}
    };
    /** One machine side: per slot what it accepts (null = anything), whether it can be extracted, and its limit. */
    static final class Machine implements GenericItemSlots.Slots<Stack> {
        final Stack[] items;final String[] accepts;final boolean[] extractable;final int[] limits;
        int realShortfall,realInserts,brokenSlot=-1;String throwIn;Stack overReturn;
        Machine(int size){items=new Stack[size];accepts=new String[size];extractable=new boolean[size];limits=new int[size];Arrays.fill(items,EMPTY);Arrays.fill(extractable,true);Arrays.fill(limits,64);}
        Machine slot(int i,String accept,boolean out,int limit){accepts[i]=accept;extractable[i]=out;limits[i]=limit;return this;}
        Machine put(int i,String id,int n){items[i]=new Stack(id,n);return this;}
        private void maybeThrow(String where){if(where.equals(throwIn))throw new IllegalStateException(where+" broke");}
        public int size(){maybeThrow("size");return items.length;}
        public Stack get(int slot){maybeThrow("get");return items[slot];}
        public int limit(int slot){return limits[slot];}
        public boolean valid(int slot,Stack s){maybeThrow("valid");return accepts[slot]==null||accepts[slot].equals(s.id());}
        public Stack insert(int slot,Stack s,boolean simulate){
            maybeThrow(simulate?"simulateInsert":"insert");
            if(simulate&&slot==brokenSlot)throw new IllegalStateException("slot "+slot+" broke");
            if(overReturn!=null&&simulate)return overReturn;
            if(!valid(slot,s)||(items[slot].count()>0&&!items[slot].id().equals(s.id())))return s;
            int n=Math.min(limits[slot]-items[slot].count(),s.count());if(!simulate)n=Math.max(0,n-realShortfall);
            if(n<=0)return s;
            if(!simulate){items[slot]=new Stack(s.id(),items[slot].count()+n);realInserts++;}
            return STACKS.copy(s,s.count()-n);
        }
        public Stack extract(int slot,int amount,boolean simulate){
            maybeThrow(simulate?"simulateExtract":"extract");
            if(!extractable[slot]||items[slot].count()==0)return EMPTY;
            int n=Math.min(amount,items[slot].count());Stack out=new Stack(items[slot].id(),n);
            if(!simulate)items[slot]=STACKS.copy(items[slot],items[slot].count()-n);
            return out;
        }
        int count(String id){int n=0;for(Stack s:items)if(s.id().equals(id))n+=s.count();return n;}
    }
    /** The body: a counted pocket for inserts, a room of fixed size for extracts. */
    static final class Body implements GenericItemSlots.Pocket<Stack>,GenericItemSlots.Room<Stack> {
        final Map<String,Integer> held=new TreeMap<>();int space;int spilled;
        Body(int space){this.space=space;}
        public void take(int n){held.merge("taken",n,Integer::sum);}
        public void giveBack(Stack rest){held.merge("taken",-rest.count(),Integer::sum);}
        public int room(Stack s){return space;}
        public Stack put(Stack s){int n=Math.min(space,s.count());space-=n;held.merge(s.id(),n,Integer::sum);return STACKS.copy(s,s.count()-n);}
        public void spill(Stack s){spilled+=s.count();}
        int get(String key){return held.getOrDefault(key,0);}
    }
    static final Stack ORE=new Stack("examplemod:ore",1),COAL=new Stack("minecraft:coal",1);

    static void run() throws Exception {
        // Config: one object of mod id to exact version; any mistake skips the whole file; minecraft is never generic.
        check(GenericItemSlots.parse(JsonParser.parseString("{\"mods\":{\"examplemod\":\"1.2.3\"},\"note\":\"crusher\"}").getAsJsonObject()).equals(Map.of("examplemod","1.2.3")),"mod pinned to an exact version");
        rejects("{\"mods\":{\"examplemod\":\"1.2.3\"},\"blocks\":[]}","unknown key blocks");
        rejects("{\"mods\":[\"examplemod\"]}","mods must be an object");
        rejects("{\"mods\":{\"minecraft\":\"1.21.1\"}}","vanilla");
        rejects("{\"mods\":{\"examplemod\":\"\"}}","non-empty");
        rejects("{\"mods\":{\"Example Mod\":\"1\"}}","bad mod id");
        Path dir=Files.createTempDirectory("mcbot-item-handlers");
        try {
            List<String> problems=new ArrayList<>();
            check(GenericItemSlots.load(dir.resolve(GenericItemSlots.FILE),problems).isEmpty()&&problems.isEmpty(),"no config file: nothing enabled, nothing to report");
            Files.writeString(dir.resolve(GenericItemSlots.FILE),"{\"mods\":{\"examplemod\":1}}");
            check(GenericItemSlots.load(dir.resolve(GenericItemSlots.FILE),problems).isEmpty()&&problems.size()==1&&problems.getFirst().contains(GenericItemSlots.FILE),"broken config enables nothing and is reported");
            Files.writeString(dir.resolve(GenericItemSlots.FILE),"{\"mods\":{\"examplemod\":\"1.2.3\",\"othermod\":\"2.0\"}}");
            problems.clear();
            LoaderPlatform previous=LoaderPlatform.installedOrNull();
            try {
                LoaderPlatform.install(fake(Map.of("minecraft","1.21.1","neoforge","21.1.217","examplemod","1.2.3","othermod","2.1")));
                Set<String> enabled=GenericItemSlots.enabled(GenericItemSlots.load(dir.resolve(GenericItemSlots.FILE),problems),McbotApi::versionsMatch,problems);
                check(enabled.equals(Set.of("examplemod")),"only the mod at its pinned version is enabled: "+enabled);
                check(problems.size()==1&&problems.getFirst().contains("othermod"),"a version mismatch stays off and is reported: "+problems);
            } finally { if(previous!=null)LoaderPlatform.install(previous); }
        } finally { try(var files=Files.list(dir)){for(Path p:files.toList())Files.delete(p);} Files.delete(dir); }

        // Dispatch: unknown mods refused, enabled ones allowed, dedicated adapters and vanilla always win.
        Set<String> enabled=Set.of("examplemod");
        String off=GenericItemSlots.refusal("othermod",null,enabled);
        check(off!=null&&off.contains("off for mod othermod")&&off.contains(GenericItemSlots.FILE),"a mod not enabled is refused with where to enable it");
        check(GenericItemSlots.refusal("examplemod",null,enabled)==null,"an enabled mod without a dedicated adapter may use generic access");
        String dedicated=GenericItemSlots.refusal("ironfurnaces",IronFurnaceAdapter.INSTANCE.id(),Set.of("ironfurnaces"));
        check(dedicated!=null&&dedicated.contains(IronFurnaceAdapter.INSTANCE.id()),"a dedicated adapter wins even when its mod is enabled for generic access");
        check(GenericItemSlots.refusal("minecraft",null,Set.of("minecraft"))!=null,"vanilla blocks never use generic access");

        // Sides: omitted is the unsided handler, the six faces by name, anything else is refused.
        check(GenericItemSlots.side(null)==null&&"up".equals(GenericItemSlots.side("up")),"unsided and named faces");
        code("INVALID_ARGUMENT",()->GenericItemSlots.side("top"),"unknown side name refused");
        Machine top=new Machine(1).slot(0,ORE.id(),false,64),bottom=new Machine(1).slot(0,"nothing",true,64).put(0,"examplemod:dust",5),all=new Machine(2);
        Map<String,Machine> faces=new HashMap<>();faces.put(null,all);faces.put("up",top);faces.put("down",bottom);
        var offered=GenericItemSlots.sides(side->{if("east".equals(side))throw new IllegalStateException("broken side");return faces.get(side);});
        check(offered.size()==3&&offered.get(0).getKey()==null&&offered.get(0).getValue()==2&&offered.get(1).getKey().equals("down")&&offered.get(2).getKey().equals("up"),"sides list unsided first, then faces; a throwing side is left out: "+offered);
        Body body=new Body(64);
        var intoTop=GenericItemSlots.insert(top,STACKS,ORE,3,-1,body);
        check(intoTop.count==3&&top.count(ORE.id())==3&&body.get("taken")==3,"the top face takes ore into its input");
        var intoBottom=GenericItemSlots.insert(bottom,STACKS,ORE,3,-1,new Body(64));
        check(intoBottom.count==0&&intoBottom.invalidSlots==1&&bottom.realInserts==0,"the bottom face refuses ore by isItemValid and is never really called");
        var fromTop=GenericItemSlots.extract(top,STACKS,s->true,3,-1,new Body(64));
        check(fromTop.count==0&&fromTop.withheld==3&&fromTop.fault==null,"the top face does not give its input back, and says it holds 3: "+fromTop.withheld);
        var fromBottom=GenericItemSlots.extract(bottom,STACKS,s->true,64,-1,body);
        check(fromBottom.count==5&&body.get("examplemod:dust")==5&&bottom.count("examplemod:dust")==0,"the bottom face gives out its product");

        // Insert: simulate first, then exactly what was accepted, slot by slot; counts are what really moved.
        Machine crusher=new Machine(3).slot(0,ORE.id(),true,16).slot(1,COAL.id(),true,64).slot(2,ORE.id(),true,8);
        Body pocket=new Body(0);
        var full=GenericItemSlots.insert(crusher,STACKS,ORE,20,-1,pocket);
        check(full.count==20&&full.steps.equals(List.of(new GenericItemSlots.Step(0,16),new GenericItemSlots.Step(2,4)))&&full.invalidSlots==1&&pocket.get("taken")==20,"16 into slot 0, coal slot refused by isItemValid, 4 into slot 2: "+full.steps);
        var partial=GenericItemSlots.insert(crusher,STACKS,ORE,10,-1,pocket);
        check(partial.count==4&&partial.fault==null&&!partial.unknown&&pocket.get("taken")==24&&crusher.count(ORE.id())==24,"only 4 more fit: the result says 4, the body gave up 4");
        var none=GenericItemSlots.insert(crusher,STACKS,COAL,5,0,new Body(0));
        check(none.count==0&&none.invalidSlots==1,"a chosen slot that refuses the item moves nothing");
        code("INVALID_ARGUMENT",()->GenericItemSlots.insert(crusher,STACKS,ORE,1,7,new Body(0)),"a slot outside the handler is refused");
        Machine stingy=new Machine(1);stingy.realShortfall=3;Body back=new Body(0);
        var shortfall=GenericItemSlots.insert(stingy,STACKS,ORE,10,-1,back);
        check(shortfall.count==7&&back.get("taken")==7&&stingy.count(ORE.id())==7,"a real insert taking less than simulated gives the rest back and reports 7");

        // Extract: only matching items, never more than the body can hold.
        Machine furnace=new Machine(3).slot(0,ORE.id(),true,64).slot(2,"nothing",true,64).put(0,ORE.id(),4).put(2,"examplemod:ingot",10);
        Body small=new Body(6);
        var ingots=GenericItemSlots.extract(furnace,STACKS,s->s.id().equals("examplemod:ingot"),64,-1,small);
        check(ingots.count==6&&small.get("examplemod:ingot")==6&&furnace.count("examplemod:ingot")==4&&furnace.count(ORE.id())==4,"only the ingots, and only as many as fit");
        check("Inventory is full".equals(GenericItemSlots.extract(furnace,STACKS,s->true,64,2,new Body(0)).fault),"a full body takes nothing and says why");
        var oneSlot=GenericItemSlots.extract(furnace,STACKS,s->true,2,0,new Body(64));
        check(oneSlot.count==2&&furnace.count(ORE.id())==2,"extract from a chosen slot only");

        // Faults: before anything moved the action is refused; during a real call the result is unknown.
        Machine broken=new Machine(2);broken.throwIn="valid";
        code("UNSUPPORTED",()->GenericItemSlots.insert(broken,STACKS,ORE,1,-1,new Body(0)),"isItemValid throwing before any move refuses");
        Machine lying=new Machine(1);lying.overReturn=new Stack(ORE.id(),99);
        code("UNSUPPORTED",()->GenericItemSlots.insert(lying,STACKS,ORE,5,-1,new Body(0)),"a simulation that returns more than it was given is out of contract");
        Machine realThrows=new Machine(1);realThrows.throwIn="insert";Body lost=new Body(0);
        var unknown=GenericItemSlots.insert(realThrows,STACKS,ORE,5,-1,lost);
        check(unknown.unknown&&unknown.count==0&&unknown.uncertain==5&&lost.get("taken")==5,"a real insert that throws is unknown, the 5 in flight are reported uncertain and not given back");
        Machine extractThrows=new Machine(1).put(0,ORE.id(),3);extractThrows.throwIn="extract";
        var unknownOut=GenericItemSlots.extract(extractThrows,STACKS,s->true,3,-1,new Body(64));
        check(unknownOut.unknown&&unknownOut.uncertain==3,"a real extract that throws is unknown");
        Machine later=new Machine(2).slot(0,ORE.id(),true,2);
        var kept=GenericItemSlots.insert(later,STACKS,ORE,5,-1,new Body(0));
        check(kept.count==5,"control: two slots take 5");
        Machine laterBroken=new Machine(2).slot(0,ORE.id(),true,2);laterBroken.brokenSlot=1;
        var halfway=GenericItemSlots.insert(laterBroken,STACKS,ORE,5,-1,new Body(0));
        check(halfway.count==2&&!halfway.unknown&&halfway.fault!=null&&halfway.fault.contains("slot 1 broke"),"a simulation failing after a real move keeps the certain 2 and is not unknown");
        Machine sizeBroken=new Machine(1);sizeBroken.throwIn="size";
        code("UNSUPPORTED",()->GenericItemSlots.contents(sizeBroken,STACKS),"a listing whose handler throws is refused");
        var listing=GenericItemSlots.contents(furnace,STACKS);
        check(listing.size()==3&&listing.get(1).stack()==null&&listing.get(2).stack().count()==4&&listing.get(0).limit()==64,"listing shows every slot, empty ones without a stack");
        System.out.println("GenericItemSlotsTest: "+checks+" checks passed (config, dispatch, sides, insert, extract, faults)");
    }
    private static LoaderPlatform fake(Map<String,String> versions) {
        return new LoaderPlatform() {
            public String loader(){return "neoforge";}
            public String loaderModId(){return "neoforge";}
            public String modVersion(String id){return versions.getOrDefault(id,"");}
            public int burnTime(ItemStack stack,RecipeType<?> type){return 0;}
        };
    }
}
