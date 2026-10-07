package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.workstation.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.*;
import net.minecraft.world.item.crafting.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * workstation-options: answers without touching anything. Which stations are within 16 blocks; how an item is made
 * (which tool, which station, what is missing); references to exact stacks for modify-item. Enchanting offers and
 * anvil costs depend on the opened station, so those come from modify-item with preview.
 */
final class StationQuery {
    private StationQuery() {}
    static JsonObject run(ServerPlayer player,JsonObject args,SubjectRefs refs) {
        JsonObject result=new JsonObject();
        result.add("stations",stations(player));
        if(args.has("item"))result.add("ways",ways(player,item(string(args,"item")),args.has("potion")?string(args,"potion"):null,args.has("count")?(int)bounded(args,"count",1,1,64):1));
        if(args.has("subjects"))result.add("subjects",subjects(player,string(args,"subjects"),refs));
        result.addProperty("levels",player.experienceLevel);
        return result;
    }
    private static JsonArray stations(ServerPlayer player) {
        JsonArray list=new JsonArray();
        for(BlockPos pos:nearby(player,s->station(s)!=null,16)) {
            WorkstationAdapter adapter=station(player.serverLevel().getBlockState(pos));
            list.add(obj("station",adapter.id(),"kind",adapter.template().name().toLowerCase(Locale.ROOT),"at",pos(pos),"distance",Math.round(Vec3.atCenterOf(pos).distanceTo(player.position())*10)/10.0));
        }
        return list;
    }
    private static WorkstationAdapter station(BlockState state) {
        for(Template template:Template.values()){WorkstationAdapter a=ModAdapters.workstation(state,template);if(a!=null)return a;}
        return null;
    }
    private static JsonArray options(Ingredient ingredient){JsonArray a=new JsonArray();ItemStack[] items=ingredient.getItems();for(int i=0;i<Math.min(6,items.length);i++)a.add(id(items[i]));return a;}
    private static JsonArray ways(ServerPlayer player,Item wanted,String potion,int count) {
        JsonArray ways=new JsonArray();Inventory inventory=player.getInventory();
        if(ProduceTask.potionItem(wanted)&&potion!=null) {
            ways.add(obj("tool","produce-item","station","minecraft:brewing_stand","args",obj("item",id(wanted),"potion",potion,"count",Math.min(count,3)),"note","produce-item plans the brewing stages and says what is missing"));
            return ways;
        }
        List<StationRecipe> crafting=VanillaWorkstations.CRAFTING.producing(player,wanted);
        if(!crafting.isEmpty()) {
            StationRecipe best=null;JsonArray shortest=null;
            for(StationRecipe r:crafting){int crafts=(count+r.result().getCount()-1)/r.result().getCount();JsonArray m=missing(r,inventory,crafts);if(shortest==null||m.size()<shortest.size()){best=r;shortest=m;}}
            ways.add(obj("tool","craft-item","recipe",best.id().toString(),"needsTable",!best.fits(2,2),"missing",shortest));
        }
        Set<String> seen=new HashSet<>();
        for(var entry:List.of(Map.entry("minecraft:furnace",RecipeType.SMELTING),Map.entry("minecraft:smoker",RecipeType.SMOKING),Map.entry("minecraft:blast_furnace",RecipeType.BLASTING)))
            for(var holder:player.getServer().getRecipeManager().getAllRecipesFor(entry.getValue())) {
                AbstractCookingRecipe recipe=holder.value();
                if(!recipe.getResultItem(player.registryAccess()).is(wanted)||recipe.getIngredients().isEmpty()||!seen.add(entry.getKey()+holder.id()))continue;
                ways.add(obj("tool","smelt-item","station",entry.getKey(),"recipe",holder.id().toString(),"input",options(recipe.getIngredients().getFirst())));
                if(seen.size()>6)break;
            }
        for(StationRecipe r:VanillaWorkstations.STONECUTTING.producing(player,wanted)) {
            int need=(count+r.result().getCount()-1)/r.result().getCount();
            JsonObject way=obj("tool","produce-item","station","minecraft:stonecutter","recipe",r.id().toString(),"input",options(r.cells().getFirst()),"perInput",r.result().getCount());
            JsonArray m=missing(r,inventory,need);if(m.size()>0)way.add("missing",m);
            ways.add(way);if(ways.size()>12)break;
        }
        return ways;
    }
    /** References to main-inventory stacks of this item (or every stack for "*"), for modify-item. */
    private static JsonArray subjects(ServerPlayer player,String which,SubjectRefs refs) {
        Item item=which.equals("*")?null:item(which);
        JsonArray list=new JsonArray();Inventory inventory=player.getInventory();
        for(int i=0;i<36;i++) {
            ItemStack s=inventory.getItem(i);
            if(s.isEmpty()||item!=null&&!s.is(item))continue;
            JsonObject entry=ItemDescriptions.describe(s);entry.addProperty("ref",refs.issue(player,i));entry.addProperty("slot",i);
            list.add(entry);
        }
        return list;
    }
    private static String id(ItemStack stack){return NativeWorkstation.id(stack);}
    private static String id(Item item){return NativeWorkstation.id(item);}
}
