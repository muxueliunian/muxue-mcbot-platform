package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.*;
import static com.mcbot.servercontrol.Protocol.*;

/** First batch: ordinary vanilla Item food semantics, no effects or special consume implementations. */
final class FoodSafety {
    record Profile(FoodProperties food,boolean safe,String reason) {}
    static Profile assess(ItemStack stack,ServerPlayer player) {
        FoodProperties food=stack.getFoodProperties(player);
        if(food==null) return new Profile(null,false,"NOT_FOOD");
        String reason=reason(BuiltInRegistries.ITEM.getKey(stack.getItem()).getNamespace().equals("minecraft"),stack.getItem().getClass()==Item.class,
            food.nutrition(),food.saturation(),food.eatDurationTicks(),!food.effects().isEmpty(),stack.is(Items.GOLDEN_APPLE)||stack.is(Items.ENCHANTED_GOLDEN_APPLE));
        if(reason==null&&food.usingConvertsTo().isPresent()) {
            ItemStack result=food.usingConvertsTo().get();
            if(!result.is(Items.BOWL)||result.getCount()!=1) reason="UNVERIFIED_RETURN_ITEM";
        }
        return new Profile(food,reason==null,reason);
    }
    static String reason(boolean vanilla,boolean ordinary,int nutrition,float saturation,int duration,boolean effects,boolean protectedFood) {
        if(!vanilla||!ordinary) return "UNVERIFIED_FOOD_IMPLEMENTATION";
        if(protectedFood) return "PROTECTED_FOOD";
        if(effects) return "FOOD_EFFECTS_NOT_ALLOWED";
        if(nutrition<1||!Float.isFinite(saturation)||saturation<0||duration<1||duration>1200) return "UNVERIFIED_FOOD_PROPERTIES";
        return null;
    }
    static JsonObject candidate(int slot,ItemStack stack,ServerPlayer player) {
        String id=BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        try {
            Profile profile=assess(stack,player);if(profile.food()==null)return null;
            FoodProperties food=profile.food();
            return metadata(slot,id,stack.getCount(),food.nutrition(),food.saturation(),food.eatDurationTicks(),profile.safe(),profile.reason());
        } catch(RuntimeException failure) {
            return unavailable(slot,id,stack.getCount(),"FOOD_PROPERTIES_UNAVAILABLE");
        }
    }
    static JsonObject metadata(int slot,String id,int count,int nutrition,float saturation,int duration,boolean safe,String reason) {
        if(nutrition<0||!Float.isFinite(saturation)||saturation<0||duration<1||duration>1200)return unavailable(slot,id,count,"UNVERIFIED_FOOD_PROPERTIES");
        JsonObject result=obj("slot",slot,"id",id,"count",count,"nutrition",nutrition,"saturationModifier",nutrition>0?saturation/(2f*nutrition):0,
            "saturationPoints",saturation,"eatDurationTicks",duration,"safe",safe);
        if(reason!=null)result.addProperty("reason",reason);return result;
    }
    private static JsonObject unavailable(int slot,String id,int count,String reason) {
        return obj("slot",slot,"id",id,"count",count,"nutrition",0,"saturationModifier",0,"saturationPoints",0,"eatDurationTicks",0,"safe",false,"metadataIncomplete",true,"reason",reason);
    }
}
