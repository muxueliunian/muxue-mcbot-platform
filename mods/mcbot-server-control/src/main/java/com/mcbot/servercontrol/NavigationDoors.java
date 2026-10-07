package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.*;

/**
 * Doors on a route, used like a player: vanilla's path finder may lead through a closed door that opens by hand
 * (wooden ones, not iron); the body stops in front of it and right-clicks it open, walks through, and once it is
 * clear of the doorway closes the doors it opened itself. Doors someone else left open stay open.
 */
final class NavigationDoors {
    static final double OPEN_REACH=3.5,CLOSE_MIN=1.3,CLOSE_MAX=4;
    private final Supplier<BodyPlayer> body;
    private final Set<BlockPos> mine=new LinkedHashSet<>();
    int opened,closed;
    NavigationDoors(Supplier<BodyPlayer> body){this.body=body;}
    static boolean handDoor(BlockState state){return state.getBlock() instanceof DoorBlock door&&door.type().canOpenByHand();}
    /** Lower half of the hand-openable door at this block, or null. */
    private BlockPos door(BlockPos pos) {
        BodyPlayer player=body.get();
        if(!player.serverLevel().isLoaded(pos))return null;
        BlockState state=player.serverLevel().getBlockState(pos);
        if(!handDoor(state))return null;
        return state.getValue(DoorBlock.HALF)==DoubleBlockHalf.LOWER?pos.immutable():pos.below().immutable();
    }
    /** One tick before steering; true when this tick was spent on a door (no movement). */
    boolean tick(Vec3 feet,List<Vec3> route,int index) {
        BodyPlayer player=body.get();
        // Close what we opened once we are through it.
        for(Iterator<BlockPos> it=mine.iterator();it.hasNext();){
            BlockPos d=it.next();BlockState state=player.serverLevel().getBlockState(d);
            if(!handDoor(state)||!state.getValue(DoorBlock.OPEN)){it.remove();continue;}
            double distance=Math.hypot(feet.x-(d.getX()+0.5),feet.z-(d.getZ()+0.5));
            if(distance>CLOSE_MAX+0.5){it.remove();continue;}
            boolean ahead=false;for(int i=index;i<route.size();i++){BlockPos node=BlockPos.containing(route.get(i));if(node.equals(d)||node.equals(d.above()))ahead=true;}
            if(ahead||distance<CLOSE_MIN||player.getBoundingBox().inflate(0.1).intersects(new AABB(d).expandTowards(0,1,0)))continue;
            if(!player.onGround())continue;
            player.stopInput();use(player,d);it.remove();closed++;return true;
        }
        // Open a closed door on the next two nodes.
        for(int i=index;i<Math.min(route.size(),index+2);i++){
            BlockPos node=BlockPos.containing(route.get(i));
            for(BlockPos at:List.of(node,node.above())){
                BlockPos d=door(at);if(d==null)continue;
                BlockState state=player.serverLevel().getBlockState(d);
                if(state.getValue(DoorBlock.OPEN))continue;
                if(player.getEyePosition().distanceTo(Vec3.atCenterOf(d))>OPEN_REACH||!player.onGround())return false;
                player.stopInput();use(player,d);
                if(player.serverLevel().getBlockState(d).getValue(DoorBlock.OPEN)){mine.add(d);opened++;}
                return true;
            }
        }
        return false;
    }
    /** On arrival: close every door we opened that the body is no longer standing in, however close it still is. */
    void arrived() {
        BodyPlayer player=body.get();
        for(Iterator<BlockPos> it=mine.iterator();it.hasNext();){
            BlockPos d=it.next();BlockState state=player.serverLevel().getBlockState(d);
            if(!handDoor(state)||!state.getValue(DoorBlock.OPEN)){it.remove();continue;}
            if(player.getBoundingBox().intersects(new AABB(d).expandTowards(0,1,0)))continue;
            if(player.getEyePosition().distanceTo(Vec3.atCenterOf(d))>CLOSE_MAX+0.5){it.remove();continue;}
            use(player,d);it.remove();closed++;
        }
    }
    private static int sequence;
    private static void use(BodyPlayer player,BlockPos d) {
        BlockState state=player.serverLevel().getBlockState(d);
        var shape=state.getShape(player.serverLevel(),d);
        Vec3 aim=shape.isEmpty()?Vec3.atCenterOf(d):shape.bounds().move(d).getCenter();
        Vec3 eye=player.getEyePosition();
        Direction face=Direction.getNearest(eye.x-aim.x,0,eye.z-aim.z);
        NativeWorkstation.look(player,aim);
        player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,new BlockHitResult(aim,face,d,false),++sequence));
    }
}
