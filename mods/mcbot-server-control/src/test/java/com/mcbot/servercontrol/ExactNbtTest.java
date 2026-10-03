package com.mcbot.servercontrol;

import com.google.gson.*;
import net.minecraft.nbt.*;

final class ExactNbtTest {
    private static int checks;
    private static void check(boolean condition,String message) {checks++;if(!condition)throw new AssertionError(message);}
    static void run() {
        check(!ExactNbt.encode(ByteTag.valueOf((byte)1)).equals(ExactNbt.encode(IntTag.valueOf(1))),"equal numeric values preserve byte versus int type");
        CompoundTag byteData=new CompoundTag();byteData.putByte("permission",(byte)1);
        CompoundTag intData=new CompoundTag();intData.putInt("permission",1);
        check(!ExactNbt.encode(byteData).equals(ExactNbt.encode(intData)),"same field names and values with changed NBT type fail exact guard");
        check(ExactNbt.encode(byteData).equals(ExactNbt.encode(byteData.copy())),"actual unchanged NBT copy matches field by field");
        long wide=9_007_199_254_740_993L;
        JsonObject exact=ExactNbt.encode(LongTag.valueOf(wide));
        check(exact.get("value").getAsJsonPrimitive().isString()&&exact.get("value").getAsString().equals("9007199254740993"),"wide long survives JSON/JS number projection as decimal text");
        check(!ExactNbt.encode(new ByteArrayTag(new byte[]{1,2})).equals(ExactNbt.encode(new IntArrayTag(new int[]{1,2}))),"byte and int arrays retain distinct types");
        JsonObject longs=ExactNbt.encode(new LongArrayTag(new long[]{wide,Long.MIN_VALUE,Long.MAX_VALUE}));
        check(longs.getAsJsonArray("value").get(0).getAsString().equals("9007199254740993")&&longs.getAsJsonArray("value").get(2).getAsString().equals("9223372036854775807"),"long arrays retain all precision");
        check(!ExactNbt.encode(FloatTag.valueOf(0.1f)).equals(ExactNbt.encode(DoubleTag.valueOf(0.1d))),"float and double preserve their native type");
        check(ExactNbt.encode(FloatTag.valueOf(-0.0f)).get("value").getAsString().equals("0.0"),"encoding follows native FloatTag's zero canonicalization");
        check(ExactNbt.encode(DoubleTag.valueOf(Math.nextUp(1.0d))).get("value").getAsString().equals("1.0000000000000002"),"adjacent double values preserve their precise decimal text");
        check(ExactNbt.encode(DoubleTag.valueOf(Double.NaN)).get("value").getAsString().equals("NaN"),"nonfinite native value is representable without invalid JSON numbers");
        ListTag list=new ListTag();list.add(LongTag.valueOf(wide));
        JsonObject listData=ExactNbt.encode(list);
        check(listData.get("elementType").getAsString().equals("long")&&listData.getAsJsonArray("value").get(0).getAsJsonObject().get("value").getAsString().equals("9007199254740993"),"list element types and wide values remain exact");
        String wire=Protocol.JSON.toJson(ExactNbt.encode(intData));
        check(JsonParser.parseString(wire).equals(ExactNbt.encode(intData)),"typed representation survives plain JSON round trip");
        CompoundTag nestedItem=new CompoundTag();nestedItem.put("minecraft:custom_data",byteData.copy());
        CompoundTag outer=new CompoundTag();outer.put("components",nestedItem);
        JsonObject before=ExactNbt.encode(outer);
        nestedItem.put("minecraft:custom_data",intData.copy());
        check(!before.equals(ExactNbt.encode(outer)),"nested container item components retain NBT type changes");
        CompoundTag wideData=new CompoundTag();wideData.putLong("value",wide);nestedItem.put("minecraft:custom_data",wideData);
        JsonObject wideBefore=ExactNbt.encode(outer);wideData.putLong("value",wide-1);
        check(!wideBefore.equals(ExactNbt.encode(outer)),"nested wide longs that alias in JS numbers remain distinguishable");
        System.out.println("ExactNbtTest: "+checks+" checks passed");
    }
}
