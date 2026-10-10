package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Ordinary vanilla food semantics (plain items and plantable crops), no effects or special consume implementations. */
final class FoodSafety {
    /** precious = safe but valuable (golden apples): the runtime eats it only on request or in an emergency. Not a safety reason. */
    record Profile(FoodProperties food,boolean safe,boolean precious,String reason) {}
    static Profile assess(ItemStack stack,ServerPlayer player) {
        FoodProperties food=stack.getFoodProperties(player);
        if(food==null) return new Profile(null,false,false,"NOT_FOOD");
        // Plantable food (carrot, potato, sweet berries) is an ItemNameBlockItem; eaten from the hand it is plain Item food.
        Class<?> kind=stack.getItem().getClass();
        String reason=reason(BuiltInRegistries.ITEM.getKey(stack.getItem()).getNamespace().equals("minecraft"),kind==Item.class||kind==ItemNameBlockItem.class,
            // Golden apples: their effects (regeneration, absorption, resistance, fire resistance) only help; still precious below.
            food.nutrition(),food.saturation(),food.eatDurationTicks(),!food.effects().isEmpty()&&!precious(stack));
        if(reason==null&&food.usingConvertsTo().isPresent()) {
            ItemStack result=food.usingConvertsTo().get();
            if(!result.is(Items.BOWL)||result.getCount()!=1) reason="UNVERIFIED_RETURN_ITEM";
        }
        return new Profile(food,reason==null,reason==null&&precious(stack),reason);
    }
    static boolean precious(ItemStack stack) {return stack.is(Items.GOLDEN_APPLE)||stack.is(Items.ENCHANTED_GOLDEN_APPLE);}
    static boolean precious(String id) {return id.equals("minecraft:golden_apple")||id.equals("minecraft:enchanted_golden_apple");}
    static String reason(boolean vanilla,boolean ordinary,int nutrition,float saturation,int duration,boolean effects) {
        if(!vanilla||!ordinary) return "UNVERIFIED_FOOD_IMPLEMENTATION";
        if(effects) return "FOOD_EFFECTS_NOT_ALLOWED";
        if(nutrition<1||!Float.isFinite(saturation)||saturation<0||duration<1||duration>1200) return "UNVERIFIED_FOOD_PROPERTIES";
        return null;
    }
    static JsonObject candidate(int slot,ItemStack stack,ServerPlayer player) {
        String id=BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        try {
            Profile profile=assess(stack,player);if(profile.food()==null)return null;
            FoodProperties food=profile.food();
            return metadata(slot,id,stack.getCount(),food.nutrition(),food.saturation(),food.eatDurationTicks(),profile.safe(),profile.precious(),profile.reason());
        } catch(RuntimeException failure) {
            return unavailable(slot,id,stack.getCount(),"FOOD_PROPERTIES_UNAVAILABLE");
        }
    }
    static JsonObject metadata(int slot,String id,int count,int nutrition,float saturation,int duration,boolean safe,String reason) {return metadata(slot,id,count,nutrition,saturation,duration,safe,false,reason);}
    static JsonObject metadata(int slot,String id,int count,int nutrition,float saturation,int duration,boolean safe,boolean precious,String reason) {
        if(nutrition<0||!Float.isFinite(saturation)||saturation<0||duration<1||duration>1200)return unavailable(slot,id,count,"UNVERIFIED_FOOD_PROPERTIES");
        JsonObject result=obj("slot",slot,"id",id,"count",count,"nutrition",nutrition,"saturationModifier",nutrition>0?saturation/(2f*nutrition):0,
            "saturationPoints",saturation,"eatDurationTicks",duration,"safe",safe);
        if(safe&&precious)result.addProperty("precious",true);
        if(reason!=null)result.addProperty("reason",reason);return result;
    }
    private static JsonObject unavailable(int slot,String id,int count,String reason) {
        return obj("slot",slot,"id",id,"count",count,"nutrition",0,"saturationModifier",0,"saturationPoints",0,"eatDurationTicks",0,"safe",false,"metadataIncomplete",true,"reason",reason);
    }
}
