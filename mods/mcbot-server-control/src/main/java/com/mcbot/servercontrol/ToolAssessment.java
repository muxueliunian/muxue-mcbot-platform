package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.*;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.*;
import net.minecraft.resources.RegistryOps;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.*;
import net.minecraft.world.level.block.state.BlockState;
import static com.mcbot.servercontrol.Protocol.*;

/** Read-only candidate assessment. Never equip a candidate or invoke player harvest/break events. */
final class ToolAssessment {
    record Policy(String name,int minRemainingDurability,String dropPreference) {
        static Policy defaults(){return new Policy("fastest_valid",2,"any");}
    }
    record StackView(int slot,ItemStack stack,JsonObject item,boolean componentsComplete) {}
    record Candidate(int slot,JsonObject value,Boolean eligible,float baseSpeed,Integer remainingDurability,
                     boolean componentsComplete,boolean dropEffectsKnown,int silkTouch,int fortune) {}

    static Policy policy(JsonObject args) {
        String name=args.has("policy")?string(args,"policy"):"fastest_valid";
        if(!Set.of("fastest_valid","conserve_durability").contains(name))throw error("INVALID_ARGUMENT","Unknown tool policy");
        double reserve=bounded(args,"minRemainingDurability",2,0,1000000);
        if(reserve!=Math.rint(reserve))throw error("INVALID_ARGUMENT","minRemainingDurability must be an integer");
        String drop=args.has("dropPreference")?string(args,"dropPreference"):"any";
        if(!Set.of("any","silk_touch","no_silk_touch").contains(drop))throw error("INVALID_ARGUMENT","Unknown drop preference");
        return new Policy(name,(int)reserve,drop);
    }
    static JsonObject assess(ServerPlayer player,JsonObject args) {
        Policy policy=policy(args);
        BlockPos position=new BlockPos(coordinate(args,"x",29999000),coordinate(args,"y",2048),coordinate(args,"z",29999000));
        if(Vec3Distance.squared(player.getX(),player.getY(),player.getZ(),position)>32*32)throw error("OUT_OF_REACH","Tool assessment is limited to 32 blocks");
        if(player.serverLevel().isOutsideBuildHeight(position)||!player.serverLevel().getWorldBorder().isWithinBounds(position))throw error("UNLOADED","Assessment target is outside world bounds");
        var chunk=player.serverLevel().getChunkSource().getChunkNow(position.getX()>>4,position.getZ()>>4);
        if(chunk==null)throw error("UNLOADED","Assessment target must already be loaded");
        BlockState state=chunk.getBlockState(position);
        String id=BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if(args.has("expectedBlock")&&!string(args,"expectedBlock").equals(id))throw error("STALE_BLOCK","Assessment block differs from expectedBlock");
        float hardness=state.getDestroySpeed(player.serverLevel(),position);
        List<Candidate> candidates=evaluate(inventory(player),state,hardness);
        JsonArray visible=new JsonArray();for(Candidate candidate:candidates) {
            String exclusion=recommendationReason(candidate,policy);
            candidate.value().addProperty("recommendationEligible",exclusion==null);
            if(exclusion!=null)candidate.value().addProperty("recommendationReason",exclusion);
            visible.add(candidate.value());
        }
        JsonObject properties=new JsonObject();state.getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString()));
        JsonObject result=obj("dimension",player.serverLevel().dimension().location().toString(),"position",obj("x",position.getX(),"y",position.getY(),"z",position.getZ()),"blockId",id,"properties",properties,
            "requiresCorrectTool",state.requiresCorrectToolForDrops(),"hardness",Float.isFinite(hardness)?hardness:null,"candidates",visible,
            "policy",policy.name(),"minRemainingDurability",policy.minRemainingDurability(),"dropPreference",policy.dropPreference(),
            "notes",List.of("资格来自候选 ItemStack.isCorrectToolForDrops，属于原生基础资格，不保证 Mod 的位置／玩家 HarvestCheck 最终结果。",
                "未临时装备候选，未调用 Player.getDigSpeed、BreakSpeed 或 HarvestCheck 事件。执行时仍须按实际主手和原生规则重新核验。",
                "estimatedTicks 使用基础速度、硬度和 30／100 进度除数，不包含候选装备后的属性、附魔速度、药水、水下或离地修正。",
                "silkTouch／fortune 是栈中已记录的附魔，不预测 loot table、具体掉落数量或未知 Mod 副作用。",
                "推荐只接受完整组件、已知基础资格及耐久保护合格的候选；空热栏槽代表可选择的空手。"));
        Candidate recommended=recommend(candidates,player.getInventory().selected,policy,false);
        if(recommended!=null)result.addProperty("recommendedSlot",recommended.slot());
        return result;
    }
    private static int coordinate(JsonObject args,String key,int limit) {
        double value=number(args,key);
        if(value!=Math.rint(value)||Math.abs(value)>limit)throw error("INVALID_ARGUMENT",key+" must be an in-range integer");
        return (int)value;
    }
    private static final class Vec3Distance {
        static double squared(double x,double y,double z,BlockPos target){double dx=x-(target.getX()+0.5),dy=y-(target.getY()+0.5),dz=z-(target.getZ()+0.5);return dx*dx+dy*dy+dz*dz;}
    }
    static List<StackView> inventory(ServerPlayer player) {
        List<StackView> result=new ArrayList<>(36);
        for(int slot=0;slot<36;slot++)result.add(snapshot(slot,player.getInventory().getItem(slot),player.registryAccess()));
        return result;
    }
    /** Shared by nearby discovery: encode each inventory stack once, not once per resource block. */
    static StackView snapshot(int slot,ItemStack source,HolderLookup.Provider registries) {
        ItemStack stack=source.copy();
        JsonObject item=obj("slot",slot,"id",stack.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(),"count",stack.getCount());
        if(!stack.isEmpty()) {
            try {item.addProperty("maxStackSize",stack.getMaxStackSize());}
            catch(RuntimeException failure){item.addProperty("metadataReason","STACK_MAXIMUM_UNKNOWN");}
        }
        boolean complete;
        try {item.add("components",components(stack,registries));complete=true;}
        catch(RuntimeException failure){complete=false;item.addProperty("componentsReason","COMPONENTS_INCOMPLETE");}
        item.addProperty("componentsComplete",complete);
        return new StackView(slot,stack,item,complete);
    }
    private static JsonObject components(ItemStack stack,HolderLookup.Provider registries) {
        if(stack.isEmpty())return new JsonObject();
        for(var entry:stack.getComponents())if(entry.type().isTransient())throw error("UNSUPPORTED","Transient component cannot form a complete guard");
        Tag encoded=DataComponentMap.CODEC.encodeStart(RegistryOps.create(NbtOps.INSTANCE,registries),stack.getComponents()).result()
            .orElseThrow(()->error("UNSUPPORTED","Item components cannot form a complete guard"));
        if(!(encoded instanceof CompoundTag compound))throw error("UNSUPPORTED","Components must have a complete compound representation");
        JsonObject result=new JsonObject();for(String name:compound.getAllKeys())result.add(name,ExactNbt.encode(compound.get(name)));return result;
    }
    static List<Candidate> evaluate(List<StackView> inventory,BlockState state,float hardness) {
        List<Candidate> result=new ArrayList<>(inventory.size());for(StackView stack:inventory)result.add(candidate(stack,state,hardness));return result;
    }
    static List<Candidate> evaluateSummary(List<StackView> inventory,BlockState state,float hardness) {
        List<Candidate> result=new ArrayList<>(inventory.size());for(StackView stack:inventory)result.add(candidate(stack,state,hardness,false));return result;
    }
    static Candidate candidate(StackView view,BlockState state,float hardness) {
        return candidate(view,state,hardness,true);
    }
    private static Candidate candidate(StackView view,BlockState state,float hardness,boolean details) {
        ItemStack stack=view.stack();JsonObject value=details?view.item().deepCopy():obj("slot",view.slot(),"count",stack.getCount());
        Boolean eligible=null;boolean nativeEligible=false,dropKnown=false;float speed=Float.NaN;Integer remaining=null;int silk=0,fortune=0;
        String reason=null;
        try {
            nativeEligible=!state.requiresCorrectToolForDrops()||stack.isCorrectToolForDrops(state);
            boolean vanilla=state.getBlock().getClass().getPackageName().startsWith("net.minecraft.")&&stack.getItem().getClass().getPackageName().startsWith("net.minecraft.")&&
                BuiltInRegistries.BLOCK.getKey(state.getBlock()).getNamespace().equals("minecraft")&&BuiltInRegistries.ITEM.getKey(stack.getItem()).getNamespace().equals("minecraft");
            eligible=vanilla?nativeEligible:null;
            speed=stack.getDestroySpeed(state);
            if(!Float.isFinite(speed)||speed<=0){speed=Float.NaN;reason="BASE_SPEED_UNKNOWN";}
            if(stack.isDamageableItem())remaining=Math.max(0,stack.getMaxDamage()-stack.getDamageValue());
            var enchantments=stack.getOrDefault(DataComponents.ENCHANTMENTS,ItemEnchantments.EMPTY);
            dropKnown=vanilla;
            for(var enchantment:enchantments.entrySet()) {
                if(enchantment.getKey().is(Enchantments.SILK_TOUCH))silk=enchantment.getIntValue();
                else if(enchantment.getKey().is(Enchantments.FORTUNE))fortune=enchantment.getIntValue();
                if(enchantment.getKey().unwrapKey().isEmpty()||!enchantment.getKey().unwrapKey().orElseThrow().location().getNamespace().equals("minecraft"))dropKnown=false;
            }
            if(!vanilla)reason="PLAYER_OR_MOD_HOOKS_UNASSESSED";
            else if(!nativeEligible)reason="INCORRECT_TOOL_FOR_DROPS";
            if(state.isAir()||!Float.isFinite(hardness)||hardness<0){eligible=false;reason="NOT_DIGGABLE";}
        } catch(RuntimeException failure) {eligible=null;dropKnown=false;reason="NATIVE_ASSESSMENT_UNKNOWN";}
        Integer ticks=estimatedTicks(hardness,speed,eligible,state.isAir());
        value.addProperty("nativeEligible",nativeEligible);value.add("eligible",JSON.toJsonTree(eligible));
        value.addProperty("eligibilityBasis","item-stack-native-base; player harvest event not evaluated");
        value.add("baseSpeed",JSON.toJsonTree(Float.isFinite(speed)?speed:null));value.addProperty("baseSpeedBasis","native-base");
        value.add("estimatedTicks",JSON.toJsonTree(ticks));value.add("remainingDurability",JSON.toJsonTree(remaining));
        value.addProperty("silkTouch",silk);value.addProperty("fortune",fortune);value.addProperty("dropEffectsKnown",dropKnown);
        value.addProperty("estimate",ticks==null?"unknown":"estimated");
        if(!view.componentsComplete())reason="COMPONENTS_INCOMPLETE";
        if(reason!=null)value.addProperty("reason",reason);
        return new Candidate(view.slot(),value,eligible,speed,remaining,view.componentsComplete(),dropKnown,silk,fortune);
    }
    static Integer estimatedTicks(float hardness,float speed,Boolean eligible,boolean air) {
        if(air||hardness<0||!Float.isFinite(hardness)||!Float.isFinite(speed)||speed<=0||eligible==null)return null;
        double ticks=Math.ceil(hardness*(eligible?30:100)/speed);
        return ticks>Integer.MAX_VALUE?null:(int)Math.max(1,ticks);
    }
    static Candidate recommend(List<Candidate> candidates,int selected,Policy policy,boolean hotbarOnly) {
        Candidate best=null;
        for(Candidate candidate:candidates) {
            if(hotbarOnly&&(candidate.slot()<0||candidate.slot()>8))continue;
            if(recommendationReason(candidate,policy)!=null)continue;
            if(best==null||better(candidate,best,selected,policy))best=candidate;
        }
        return best;
    }
    static String recommendationReason(Candidate candidate,Policy policy) {
        if(candidate.slot()<0||candidate.slot()>35)return "OUTSIDE_MAIN_INVENTORY";
        if(!Boolean.TRUE.equals(candidate.eligible()))return candidate.eligible()==null?"ELIGIBILITY_UNKNOWN":"INCORRECT_TOOL_FOR_DROPS";
        if(!candidate.componentsComplete())return "COMPONENTS_INCOMPLETE";
        // Only an already-empty hotbar is a selectable hand; an empty main slot cannot be prepared.
        if(candidate.slot()>8&&candidate.value().has("count")&&candidate.value().get("count").getAsInt()==0)return "EMPTY_MAIN_SLOT";
        if(!Float.isFinite(candidate.baseSpeed())||candidate.baseSpeed()<=0)return "BASE_SPEED_UNKNOWN";
        if(candidate.remainingDurability()!=null&&candidate.remainingDurability()<=policy.minRemainingDurability())return "DURABILITY_PROTECTED";
        if(!policy.dropPreference().equals("any")&&(!candidate.dropEffectsKnown()||
            (policy.dropPreference().equals("silk_touch")?candidate.silkTouch()==0:candidate.silkTouch()>0)))return "DROP_PREFERENCE_UNSATISFIED";
        return null;
    }
    private static boolean better(Candidate candidate,Candidate old,int selected,Policy policy) {
        if(policy.name().equals("conserve_durability")) {
            int remaining=candidate.remainingDurability()==null?Integer.MAX_VALUE:candidate.remainingDurability();
            int previous=old.remainingDurability()==null?Integer.MAX_VALUE:old.remainingDurability();
            if(remaining!=previous)return remaining>previous;
        }
        int speed=Float.compare(candidate.baseSpeed(),old.baseSpeed());if(speed!=0)return speed>0;
        if((candidate.slot()==selected)!=(old.slot()==selected))return candidate.slot()==selected;
        return candidate.slot()<old.slot();
    }
}
