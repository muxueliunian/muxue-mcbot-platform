package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.workstation.*;
import java.util.*;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.*;
import net.minecraft.world.item.alchemy.*;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * produce-item: make an item at a station that is neither a crafting grid nor a furnace. Stonecutter: the input goes
 * in, the recipe's button is pressed, the result is shift-clicked out (the game repeats until the input is used up),
 * leftovers come back. Brewing stand: a plan of stages from bottles the body holds to the wanted potion, using the
 * server's own brewing rules; bottles go in, one reagent per stage, the body waits beside the stand until every
 * bottle shows the stage's result, then takes them out. Blaze powder is added when the stand's fuel would run out.
 */
final class ProduceTask extends StationJob {
    static final int MAX_STAGES=4;
    private Item wanted;
    private int count;
    // stonecutter
    private StationRecipe recipe;
    private int inputs;
    // brewing
    private Holder<Potion> potion;
    private ItemStack startBottle;
    private List<Stage> stages;
    private int stage=-1,bottles,fuelAdded;
    private long stageStarted;
    record Stage(Item ingredient,ItemStack result) {}

    ProduceTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session){super(operation,player,session);}
    String noStationCode(){return potion!=null?"NO_BREWING_STAND":"NO_STONECUTTER";}
    private static int integer(JsonObject args,String key,int fallback,int min,int max) {
        double value=bounded(args,key,fallback,min,max);
        if(value!=Math.rint(value))throw error("INVALID_ARGUMENT",key+" must be an integer");
        return (int)value;
    }
    static boolean potionItem(Item item){return item==Items.POTION||item==Items.SPLASH_POTION||item==Items.LINGERING_POTION;}
    static Holder<Potion> potion(String id) {
        ResourceLocation key=ResourceLocation.tryParse(id.contains(":")?id:"minecraft:"+id);
        var found=key==null?Optional.<Holder.Reference<Potion>>empty():BuiltInRegistries.POTION.getHolder(key);
        if(found.isEmpty())throw error("INVALID_ARGUMENT","Unknown potion "+id);
        return found.get();
    }
    static boolean isPotion(ItemStack stack,Item item,Holder<Potion> potion) {
        if(!stack.is(item))return false;
        PotionContents contents=stack.get(DataComponents.POTION_CONTENTS);
        return contents!=null&&contents.is(potion)&&contents.customEffects().isEmpty();
    }

    @Override void begin() {
        JsonObject args=operation.args;wanted=item(string(args,"item"));
        deadline=now()+(long)bounded(args,"timeoutMs",potionItem(wanted)?240_000:30_000,1000,600_000);
        if(potionItem(wanted)||args.has("potion")) {
            if(!potionItem(wanted))throw error("INVALID_ARGUMENT","potion only goes with minecraft:potion, splash_potion or lingering_potion");
            if(!args.has("potion"))throw error("INVALID_ARGUMENT","Say which potion, e.g. potion: \"minecraft:swiftness\"");
            potion=potion(string(args,"potion"));count=integer(args,"count",1,1,3);beginBrewing();return;
        }
        count=integer(args,"count",1,1,64);
        List<StationRecipe> recipes=VanillaWorkstations.STONECUTTING.producing(player,wanted);
        if(recipes.isEmpty())throw error("NO_RECIPE",id(wanted)+" is not made at a stonecutter or brewing stand"+hint(wanted));
        Inventory inventory=player.getInventory();
        for(StationRecipe r:recipes){int need=(count+r.result().getCount()-1)/r.result().getCount();if(need<=64&&NativeWorkstation.allocate(r,inventory,need)!=null){recipe=r;inputs=need;break;}}
        if(recipe==null) {
            StationRecipe best=recipes.getFirst();int need=(count+best.result().getCount()-1)/best.result().getCount();
            failureDetail=obj("recipe",best.id().toString(),"missing",missing(best,inventory,need));
            throw error("MISSING_MATERIALS","Not enough input for "+count+" "+id(wanted)+" at a stonecutter");
        }
        findStations(List.of(VanillaWorkstations.STONECUTTER),(a,s)->true);
    }
    /** Where else the item is made, so the agent picks the right tool. */
    private String hint(Item item) {
        if(!VanillaWorkstations.CRAFTING.producing(player,item).isEmpty())return "; it is crafted: use craft-item";
        for(var type:List.of(net.minecraft.world.item.crafting.RecipeType.SMELTING,net.minecraft.world.item.crafting.RecipeType.SMOKING,net.minecraft.world.item.crafting.RecipeType.BLASTING))
            for(var holder:player.getServer().getRecipeManager().getAllRecipesFor(type))if(holder.value().getResultItem(player.registryAccess()).is(item))return "; it is smelted: use smelt-item";
        return "";
    }

    @Override void opened(AbstractContainerMenu menu,StationLayout layout) {
        if(potion!=null){openedBrewing(menu,layout);return;}
        int in=layout.slot(Port.INGREDIENT),out=layout.slot(Port.RESULT);
        if(!menu.getSlot(in).getItem().isEmpty()||!menu.getSlot(out).getItem().isEmpty()){closeMenu(player);skip("busy");return;}
        Inventory inventory=player.getInventory();
        var plan=NativeWorkstation.allocate(recipe,inventory,inputs);
        if(plan==null){fail("MISSING_MATERIALS","The input is no longer in the inventory",obj());return;}
        for(var take:plan.getFirst().entrySet())transfer(player,menu,take.getKey(),in,take.getValue());
        int button=-1;
        for(StationOption option:safely(()->station.adapter().options(player,menu),List.<StationOption>of()))if(option.id().equals(recipe.id().toString()))button=option.button();
        if(button<0){takeBack(menu,List.of(in));fail("RECIPE_REFUSED","The stonecutter did not offer "+recipe.id(),obj("recipe",recipe.id().toString()));return;}
        button(player,menu,button);
        ItemStack shown=menu.getSlot(out).getItem();
        if(shown.isEmpty()||!shown.is(wanted)){takeBack(menu,List.of(in));fail("RECIPE_REFUSED","The stonecutter did not show "+id(wanted),obj("recipe",recipe.id().toString()));return;}
        int had=total(inventory,wanted);
        quickMove(player,menu,out);
        int made=total(inventory,wanted)-had;
        boolean back=takeBack(menu,List.of(in)); // never shift-click the result again: that would cut more
        JsonObject result=obj("item",id(wanted),"requestedCount",count,"made",made,"recipe",recipe.id().toString(),"station",pos(station.pos()));
        if(!back)result.addProperty("leftInStation",true);
        if(made<=0){fail("INVENTORY_FULL","No room in the inventory for the result",result);return;}
        succeed(made<count?"Cut "+made+" of "+count+" "+id(wanted)+" (inventory full)":"Cut "+made+" "+id(wanted),result);
    }

    // ---------- brewing ----------
    private ItemStack target(){return PotionContents.createItemStack(wanted,potion);}
    /** Distinct bottle kinds in the main inventory: a sample stack and how many slots hold it. */
    private Map<ItemStack,Integer> bottlesHeld() {
        Map<ItemStack,Integer> kinds=new LinkedHashMap<>();Inventory inventory=player.getInventory();
        outer:
        for(int i=0;i<36;i++){
            ItemStack s=inventory.getItem(i);if(!potionItem(s.getItem())||s.getCount()!=1)continue;
            for(var e:kinds.entrySet())if(ItemStack.isSameItemSameComponents(e.getKey(),s)){e.setValue(e.getValue()+1);continue outer;}
            kinds.put(s.copy(),1);
        }
        return kinds;
    }
    /** Shortest chain of stages from `start` to the wanted potion using these reagents (null: any brewing reagent). */
    private List<Stage> plan(ItemStack start,Map<Item,Integer> reagents) {
        RecipeSource brewing=VanillaWorkstations.BREWING;
        Collection<Item> candidates=reagents!=null?reagents.keySet():allReagents();
        record Node(ItemStack stack,List<Stage> path) {}
        Deque<Node> queue=new ArrayDeque<>();queue.add(new Node(start,List.of()));Set<String> seen=new HashSet<>();seen.add(ItemDescriptions.key(start));
        while(!queue.isEmpty()) {
            Node node=queue.poll();
            if(isPotion(node.stack(),wanted,potion))return node.path();
            if(node.path().size()>=MAX_STAGES)continue;
            for(Item reagent:candidates) {
                if(reagents!=null&&node.path().stream().filter(s->s.ingredient()==reagent).count()>=reagents.get(reagent))continue;
                var next=brewing.transform(player,node.stack(),new ItemStack(reagent));
                if(next.isEmpty()||!seen.add(ItemDescriptions.key(next.get())))continue;
                List<Stage> path=new ArrayList<>(node.path());path.add(new Stage(reagent,next.get()));
                queue.add(new Node(next.get(),path));
            }
        }
        return null;
    }
    private List<Item> allReagents() {
        List<Item> items=new ArrayList<>();
        for(Item item:BuiltInRegistries.ITEM)if(item!=Items.AIR&&VanillaWorkstations.BREWING.isIngredient(player,new ItemStack(item)))items.add(item);
        return items;
    }
    private Map<Item,Integer> reagentsHeld() {
        Map<Item,Integer> held=new LinkedHashMap<>();Inventory inventory=player.getInventory();
        for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&VanillaWorkstations.BREWING.isIngredient(player,s))held.merge(s.getItem(),s.getCount(),Integer::sum);}
        return held;
    }
    private int plainCount(Item item){int n=0;Inventory inv=player.getInventory();for(int i=0;i<36;i++){ItemStack s=inv.getItem(i);if(plain(s)&&s.is(item))n+=s.getCount();}return n;}
    private JsonArray describe(List<Stage> path){JsonArray a=new JsonArray();for(Stage s:path)a.add(obj("ingredient",id(s.ingredient()),"result",ItemDescriptions.key(s.result())));return a;}

    private void beginBrewing() {
        Map<ItemStack,Integer> held=bottlesHeld();Map<Item,Integer> reagents=reagentsHeld();
        List<Stage> best=null;ItemStack bestStart=null;
        for(var e:held.entrySet()) {
            if(e.getValue()<count||isPotion(e.getKey(),wanted,potion))continue;
            List<Stage> path=plan(e.getKey(),reagents);
            if(path!=null&&!path.isEmpty()&&(best==null||path.size()<best.size())){best=path;bestStart=e.getKey();}
        }
        if(best==null) {
            // What would be needed: the shortest chain from a bottle held (or a water bottle) with any reagent.
            ItemStack water=PotionContents.createItemStack(Items.POTION,Potions.WATER);
            List<Stage> full=null;ItemStack from=null;
            List<ItemStack> starts=new ArrayList<>(held.keySet());starts.add(water);
            for(ItemStack start:starts){List<Stage> path=plan(start,null);if(path!=null&&!path.isEmpty()&&(full==null||path.size()<full.size())){full=path;from=start;}}
            if(full==null)throw error("NO_RECIPE","No brewing chain of up to "+MAX_STAGES+" stages makes "+ItemDescriptions.key(target()));
            JsonArray missing=new JsonArray();int bottlesHave=0;
            for(var e:held.entrySet())if(ItemStack.isSameItemSameComponents(e.getKey(),from))bottlesHave=e.getValue();
            if(bottlesHave<count)missing.add(obj("options",List.of(ItemDescriptions.key(from)),"need",count,"have",bottlesHave));
            Map<Item,Integer> need=new LinkedHashMap<>();for(Stage s:full)need.merge(s.ingredient(),1,Integer::sum);
            for(var e:need.entrySet()){int have=reagents.getOrDefault(e.getKey(),0);if(have<e.getValue())missing.add(obj("options",List.of(id(e.getKey())),"need",e.getValue(),"have",have));}
            failureDetail=obj("stages",describe(full),"missing",missing,"fuel","blaze powder, unless the brewing stand still has fuel");
            throw error("MISSING_MATERIALS","Cannot brew "+ItemDescriptions.key(target())+" from what the inventory holds: "+missing);
        }
        stages=best;startBottle=bestStart;
        findStations(List.of(VanillaWorkstations.BREWING_STAND),(a,s)->true);
    }
    private void openedBrewing(AbstractContainerMenu menu,StationLayout layout) {
        List<Integer> subjects=layout.slots(Port.SUBJECT);int reagent=layout.slot(Port.INGREDIENT),fuelSlot=layout.slot(Port.FUEL);
        if(subjects.size()<count||reagent<0){closeMenu(player);skip("menu not recognised");return;}
        for(int slot:subjects)if(!menu.getSlot(slot).getItem().isEmpty()){closeMenu(player);skip("busy with someone else's bottles");return;}
        if(!menu.getSlot(reagent).getItem().isEmpty()){closeMenu(player);skip("busy with "+id(menu.getSlot(reagent).getItem()));return;}
        WorkstationAdapter adapter=station.adapter();
        // Fuel: brews left in the stand, plus 20 per blaze powder waiting in its fuel slot.
        int fuel=safely(()->adapter.fuelLeft(menu),0);ItemStack inFuel=fuelSlot<0?ItemStack.EMPTY:menu.getSlot(fuelSlot).getItem();
        int covered=fuel+(inFuel.isEmpty()?0:inFuel.getCount()*safely(()->adapter.burnTicks(state(station.pos()),inFuel),0));
        if(covered<stages.size()) {
            Inventory inventory=player.getInventory();
            if(fuelSlot>=0&&(inFuel.isEmpty()||inFuel.is(Items.BLAZE_POWDER)))
                for(int i=0;i<36&&fuelAdded==0;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&s.is(Items.BLAZE_POWDER))fuelAdded+=transfer(player,menu,i,fuelSlot,1);}
            if(fuelAdded==0){fail("NO_FUEL","The brewing stand has fuel for "+fuel+" brews and the inventory has no blaze powder",obj("fuelLeft",fuel,"stagesNeeded",stages.size()));return;}
        }
        // Bottles: `count` copies of the planned start bottle.
        Inventory inventory=player.getInventory();int put=0;
        for(int i=0;i<36&&put<count;i++){ItemStack s=inventory.getItem(i);if(ItemStack.isSameItemSameComponents(s,startBottle)&&s.getCount()==1)put+=transfer(player,menu,i,subjects.get(put),1);}
        bottles=put;
        if(put<count){takeBack(menu,subjects);fail("MISSING_MATERIALS","Only "+put+" matching bottles could be put in",obj());return;}
        open=menu;stage=-1;nextStage();
    }
    private void nextStage() {
        stage++;
        if(stage>=stages.size()){collect("Brewed");return;}
        int reagent=layout.slot(Port.INGREDIENT);Item ingredient=stages.get(stage).ingredient();Inventory inventory=player.getInventory();int put=0;
        for(int i=0;i<36&&put==0;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&s.is(ingredient))put=transfer(player,open,i,reagent,1);}
        if(put==0){collect("Stopped: no "+id(ingredient)+" left for stage "+(stage+1));return;}
        stageStarted=now();
    }
    @Override void waitTick() {
        List<Integer> subjects=layout.slots(Port.SUBJECT).subList(0,bottles);ItemStack expected=stages.get(stage).result();
        boolean done=true;for(int slot:subjects)done&=ItemStack.isSameItemSameComponents(open.getSlot(slot).getItem(),expected);
        boolean brewing=safely(()->station.adapter().working(open),false);
        if(done&&!brewing){nextStage();return;}
        long waited=now()-stageStarted;
        // Not started within 3 s (no fuel, a rule refused it) or far past the 20 s brew: take everything back.
        if(!brewing&&waited>3_000||waited>40_000){collect("Stage "+(stage+1)+" did not brew");}
    }
    private void collect(String why) {
        AbstractContainerMenu menu=open;List<Integer> subjects=layout.slots(Port.SUBJECT).subList(0,bottles);
        int reagent=layout.slot(Port.INGREDIENT);
        boolean leftReagent=!menu.getSlot(reagent).getItem().isEmpty();
        if(leftReagent)quickMove(player,menu,reagent);
        int had=0;Inventory inventory=player.getInventory();for(int i=0;i<inventory.getContainerSize();i++)if(isPotion(inventory.getItem(i),wanted,potion))had++;
        boolean back=takeBack(menu,subjects);
        int made=-had;for(int i=0;i<inventory.getContainerSize();i++)if(isPotion(inventory.getItem(i),wanted,potion))made++;
        JsonObject result=obj("item",ItemDescriptions.key(target()),"requestedCount",count,"made",made,"stages",describe(stages),"stagesDone",Math.min(stage,stages.size()),"station",pos(station.pos()),"fuelAdded",fuelAdded);
        if(!back)result.addProperty("leftInStation",true);
        if(made>=count){succeed("Brewed "+made+" "+ItemDescriptions.key(target()),result);return;}
        fail(made>0?"PARTIAL":"BREW_FAILED",why,result);
    }
}
