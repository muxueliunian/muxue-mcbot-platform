package com.mcbot.servercontrol;

import com.google.gson.*;
import net.minecraft.nbt.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Direct typed values, not a digest: JsonOps alone loses NBT numeric types and wide longs. */
final class ExactNbt {
    private ExactNbt() { }
    private static String type(int id) {
        return switch(id) {
            case 0 -> "end";case 1 -> "byte";case 2 -> "short";case 3 -> "int";case 4 -> "long";
            case 5 -> "float";case 6 -> "double";case 7 -> "byte_array";case 8 -> "string";
            case 9 -> "list";case 10 -> "compound";case 11 -> "int_array";case 12 -> "long_array";
            default -> throw error("UNSUPPORTED","Unknown NBT tag type");
        };
    }
    static JsonObject encode(Tag tag) {
        int id=tag.getId();JsonElement value;
        switch(id) {
            case 0 -> value=JsonNull.INSTANCE;
            case 1 -> value=new JsonPrimitive(((NumericTag)tag).getAsByte());
            case 2 -> value=new JsonPrimitive(((NumericTag)tag).getAsShort());
            case 3 -> value=new JsonPrimitive(((NumericTag)tag).getAsInt());
            case 4 -> value=new JsonPrimitive(Long.toString(((NumericTag)tag).getAsLong()));
            case 5 -> value=new JsonPrimitive(Float.toString(((NumericTag)tag).getAsFloat()));
            case 6 -> value=new JsonPrimitive(Double.toString(((NumericTag)tag).getAsDouble()));
            case 7 -> value=JSON.toJsonTree(((ByteArrayTag)tag).getAsByteArray());
            case 8 -> value=new JsonPrimitive(tag.getAsString());
            case 9 -> {
                ListTag list=(ListTag)tag;JsonArray elements=new JsonArray();
                for(Tag element:list) elements.add(encode(element));
                return obj("type","list","elementType",type(list.getElementType()),"value",elements);
            }
            case 10 -> {
                CompoundTag compound=(CompoundTag)tag;JsonObject entries=new JsonObject();
                for(String key:compound.getAllKeys()) entries.add(key,encode(compound.get(key)));
                value=entries;
            }
            case 11 -> value=JSON.toJsonTree(((IntArrayTag)tag).getAsIntArray());
            case 12 -> {
                JsonArray longs=new JsonArray();
                for(long number:((LongArrayTag)tag).getAsLongArray()) longs.add(Long.toString(number));
                value=longs;
            }
            default -> throw error("UNSUPPORTED","Unknown NBT tag type");
        }
        return obj("type",type(id),"value",value);
    }
}
