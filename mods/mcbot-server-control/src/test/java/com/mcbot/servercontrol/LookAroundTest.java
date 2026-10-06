package com.mcbot.servercontrol;

import static com.mcbot.servercontrol.Protocol.*;

/** Pure rules of the read-only surroundings summary, without a world. */
final class LookAroundTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){
        checks++;try{action.run();throw new AssertionError("Expected "+code);}
        catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}
    }
    static void run(){
        check(LookAround.radius(obj())==32,"default radius is 32 blocks");
        check(LookAround.radius(obj("radius",8))==8&&LookAround.radius(obj("radius",32))==32,"radius boundaries accepted");
        errorCode("INVALID_ARGUMENT",()->LookAround.radius(obj("radius",33)));
        errorCode("INVALID_ARGUMENT",()->LookAround.radius(obj("radius",7)));
        errorCode("INVALID_ARGUMENT",()->LookAround.radius(obj("radius",12.5)));
        check(LookAround.direction(0,-5).equals("north")&&LookAround.direction(0,5).equals("south"),"north is -z, south is +z");
        check(LookAround.direction(5,0).equals("east")&&LookAround.direction(-5,0).equals("west"),"east is +x, west is -x");
        check(LookAround.direction(3,-3).equals("north-east")&&LookAround.direction(-3,3).equals("south-west"),"diagonals");
        check(LookAround.direction(0.1,0.1).equals("here"),"under half a block is here");
        check(LookAround.phase(1000).equals("day")&&LookAround.phase(12500).equals("dusk")&&LookAround.phase(18000).equals("night")&&LookAround.phase(23000).equals("dawn"),"day phases");
        check(LookAround.phase(24000L*5+1000).equals("day"),"phase wraps whole days");
        check(ServerController.CAPABILITIES.contains("look-around")&&!ServerController.atomicAction("look-around"),"look-around is a read capability, never a write action");
        System.out.println("LookAroundTest: "+checks+" checks passed");
    }
}
