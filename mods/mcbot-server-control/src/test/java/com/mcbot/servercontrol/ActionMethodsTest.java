package com.mcbot.servercontrol;

import java.net.URLClassLoader;
import java.nio.file.*;
import java.util.Comparator;
import javax.tools.ToolProvider;

/** Runs the production methods with inventory/click doubles, without adding test seams to the game code. */
final class ActionMethodsTest {
    private static String method(String file,String signature) throws Exception {
        String source=Files.readString(Path.of("src/main/java/com/mcbot/servercontrol",file));
        int start=source.indexOf(signature),brace=source.indexOf('{',start),depth=1,end=brace+1;
        if(start<0||brace<0)throw new AssertionError("Missing production method: "+signature);
        while(depth>0&&end<source.length()) {char c=source.charAt(end++);if(c=='{')depth++;else if(c=='}')depth--;}
        if(depth!=0)throw new AssertionError("Unclosed production method: "+signature);
        return source.substring(start,end);
    }
    static void run() throws Exception {
        Path directory=Files.createTempDirectory("mcbot-action-methods-").toAbsolutePath().normalize();
        try {
            String methods=method("WorkstationTask.java","private void craftIn(")+"\n"
                +method("BuildTask.java","private boolean hold(")+"\n"+method("BuildTask.java","private void bestTool(");
            Path source=directory.resolve("ActionFixture.java");
            Files.writeString(source,FIXTURE.replace("// PRODUCTION_METHODS",methods));
            var compiler=ToolProvider.getSystemJavaCompiler();
            if(compiler==null)throw new AssertionError("ActionMethodsTest needs a JDK");
            if(compiler.run(null,null,null,"-proc:none","-encoding","UTF-8","-classpath",directory.toString(),"-d",directory.toString(),source.toString())!=0)
                throw new AssertionError("Could not compile production-method fixture");
            try(var loader=new URLClassLoader(new java.net.URL[]{directory.toUri().toURL()},ClassLoader.getPlatformClassLoader())) {
                var fixture=loader.loadClass("ActionFixture");
                AssertionError failure=null;
                for(String name:new String[]{"craftCounts","toolSwap"})try {fixture.getMethod(name).invoke(null);}
                catch(java.lang.reflect.InvocationTargetException e){if(failure==null)failure=new AssertionError("Action method regressions");failure.addSuppressed(e.getCause());}
                if(failure!=null)throw failure;
            }
            System.out.println("ActionMethodsTest: mixed-yield crafting and backpack tool swap passed (production methods, native calls doubled)");
        } finally {
            Path temp=Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath().normalize();
            if(!directory.getParent().equals(temp)||!directory.getFileName().toString().startsWith("mcbot-action-methods-"))
                throw new AssertionError("Unexpected fixture cleanup path");
            try(var files=Files.walk(directory)){for(Path file:files.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(file);}
        }
    }
    private static final String FIXTURE="""
        import java.util.*;
        import java.util.function.Predicate;
        public class ActionFixture {
            static class ItemStack {
                final String id;final int count;final float speed;
                ItemStack(String id,int count,float speed){this.id=id;this.count=count;this.speed=speed;}
                int getCount(){return count;}boolean isEmpty(){return count==0;}boolean isDamageableItem(){return speed>1;}
                boolean isCorrectToolForDrops(BlockState state){return speed>1;}float getDestroySpeed(BlockState state){return speed;}
            }
            static class Inventory {
                final ItemStack[] slots=new ItemStack[36];final Map<String,Integer> materials=new HashMap<>();int selected,sticks,room=256;
                Inventory(){Arrays.setAll(slots,i->new ItemStack("air",0,1));}
                ItemStack getItem(int i){return slots[i];}ItemStack getSelected(){return slots[selected];}
            }
            static class AbstractContainerMenu {}
            static class Player {final Inventory inventory=new Inventory();final AbstractContainerMenu inventoryMenu=new AbstractContainerMenu();Inventory getInventory(){return inventory;}}
            record StationLayout(int gridWidth,int gridHeight) {}
            record StationRecipe(String id,ItemStack result,String material) {boolean fits(int w,int h){return w>=1&&h>=2;}}
            static class BlockPos {}
            static class BlockState {boolean requiresCorrectToolForDrops(){return true;}}
            enum ClickType {SWAP}
            static class JsonObject extends LinkedHashMap<String,Object> {void add(String k,Object v){put(k,v);}void addProperty(String k,Object v){put(k,v);}}
            static class JsonArray extends ArrayList<Object> {}
            static class Operation {String status,summary;JsonObject result;void finish(String s,String text,JsonObject r){status=s;summary=text;result=r;}}
            final Player player=new Player();final Operation operation=new Operation();final String wanted="stick";
            final Map<String,Integer> before=Map.of("stick",0);int count;BlockPos placedTable;boolean madeTable;
            static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
            static JsonObject obj(Object... pairs){var r=new JsonObject();for(int i=0;i<pairs.length;i+=2)r.put((String)pairs[i],pairs[i+1]);return r;}
            static String id(String item){return item;}static Object pos(BlockPos p){return p;}
            static Map<String,Integer> counts(Inventory inv){return Map.of("stick",inv.sticks);}
            static Map<String,Integer> delta(Map<String,Integer> before,Map<String,Integer> after){return Map.of("stick",after.get("stick")-before.get("stick"));}
            static int feasible(StationRecipe r,Inventory inv,int n){return Math.min(n,inv.materials.getOrDefault(r.material(),0)/2);}
            static int craft(Player p,AbstractContainerMenu m,StationLayout l,StationRecipe r,int n){
                int crafts=Math.min(feasible(r,p.inventory,n),p.inventory.room/r.result().getCount());
                p.inventory.materials.merge(r.material(),-2*crafts,Integer::sum);p.inventory.sticks+=crafts*r.result().getCount();p.inventory.room-=crafts*r.result().getCount();return crafts;
            }
            static JsonArray missing(StationRecipe r,Inventory inv,int n){var a=new JsonArray();int need=2*n-inv.materials.getOrDefault(r.material(),0);if(need>0)a.add(need);return a;}
            RuntimeException missingError(List<StationRecipe> recipes){return new IllegalArgumentException("MISSING_MATERIALS");}
            static void closeMenu(Player p){}
            void select(int slot){player.inventory.selected=slot;}
            static int menuSlot(AbstractContainerMenu m,Inventory inv,int slot){return slot;}
            static void click(Player p,AbstractContainerMenu m,int source,int target,ClickType type){
                var old=p.inventory.slots[target];p.inventory.slots[target]=p.inventory.slots[source];p.inventory.slots[source]=old;
            }
            static RuntimeException error(String code,String text){return new IllegalStateException(code+": "+text);}
            // PRODUCTION_METHODS
            static final List<StationRecipe> RECIPES=List.of(new StationRecipe("stick",new ItemStack("stick",4,1),"planks"),new StationRecipe("stick_from_bamboo_item",new ItemStack("stick",1,1),"bamboo"));
            static ActionFixture craftCase(int requested,int planks,int bamboo,int room,List<StationRecipe> recipes){
                var f=new ActionFixture();f.count=requested;f.player.inventory.materials.put("planks",planks);f.player.inventory.materials.put("bamboo",bamboo);f.player.inventory.room=room;
                f.craftIn(f.player.inventoryMenu,new StationLayout(2,2),recipes,null);return f;
            }
            static void receipt(ActionFixture f,int made,int crafts,boolean missing){
                check(f.player.inventory.sticks==made,"actual pieces: "+f.player.inventory.sticks);
                check(f.operation.result.get("made").equals(made),"receipt disagrees with actual pieces: "+f.operation.result);
                check(f.operation.result.get("crafts").equals(crafts),"total craft count: "+f.operation.result);
                check(f.operation.result.containsKey("missing")==missing,"missing must follow remaining pieces: "+f.operation.result);
            }
            public static void craftCounts(){
                var partial=craftCase(8,2,2,256,RECIPES);receipt(partial,5,2,true);
                check(partial.operation.status.equals("succeeded")&&partial.operation.summary.contains("5 of 8"),"partial receipt: "+partial.operation.summary);
                receipt(craftCase(8,2,8,256,RECIPES),8,5,false);
                receipt(craftCase(3,2,0,256,RECIPES),4,1,false);
                receipt(craftCase(2,0,4,256,RECIPES),2,2,false);
                receipt(craftCase(6,6,2,256,RECIPES.reversed()),9,3,false);
                var shortfall=craftCase(17,2,2,256,RECIPES);receipt(shortfall,5,2,true);
                check(shortfall.operation.result.get("missing").equals(List.of(6)),"remaining 12 pieces need 3 plank crafts");
                var full=craftCase(4,2,0,0,RECIPES);receipt(full,0,0,true);
                check(full.operation.status.equals("failed")&&full.operation.result.get("code").equals("INVENTORY_FULL"),"zero output is a failure");
            }
            public static void toolSwap(){
                for(int slot:new int[]{0,3,19})for(boolean full:new boolean[]{false,true}){
                    var f=new ActionFixture();f.player.inventory.selected=2;
                    if(full)for(int i=0;i<9;i++)f.player.inventory.slots[i]=new ItemStack("stone",64,1);
                    var tool=new ItemStack("iron_axe",1,6);f.player.inventory.slots[slot]=tool;
                    f.bestTool(new BlockState());check(f.player.inventory.getSelected()==tool,"selected tool from slot "+slot+", full="+full);
                    if(slot>=9)check(f.player.inventory.getItem(slot)!=tool,"source slot changed after native SWAP");
                }
            }
        }
        """;
}
