package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.*;
import net.minecraft.world.item.*;
import net.minecraft.world.item.crafting.*;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * craft-item and smelt-item: one operation that walks to the workstation when needed (crafting table within 16
 * blocks; furnace, smoker or blast furnace that can cook the input), opens it like a player and does the slot work
 * in the same tick (NativeWorkstation). smelt-item with wait keeps the furnace open, standing beside it, until the
 * input is cooked, then takes the output. Without a table nearby a 3x3 recipe may place one from the inventory.
 */
final class WorkstationTask {
    static final int SEARCH=16,VERTICAL=4;
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final boolean crafting;
    private final Deque<BlockPos> stations=new ArrayDeque<>();
    private final JsonArray skipped=new JsonArray();
    private final Map<String,Integer> before;
    private NativeNavigation navigation;
    private BlockPos station;
    private long deadline;
    // crafting
    private Item wanted;
    private int count;
    private List<Plan> plans;
    // smelting
    private Item input,fuel;
    private boolean wait,collectOnly;
    private int expectedOutput,collected;
    private JsonObject loaded;
    private long waitUntil;
    private AbstractContainerMenu furnace;
    private Item output;

    private WorkstationTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        this.operation=operation;this.player=player;this.session=session;crafting=operation.name.equals("craft-item");
        before=counts(player.getInventory());
    }
    static WorkstationTask create(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        return new WorkstationTask(operation,player,session);
    }
    /** Starts the task; a refusal throws and leaves its details (what is missing) in {@link #detail}. */
    void start() {
        if(player.containerMenu!=player.inventoryMenu)throw error("BUSY","Close the current container first");
        if(!player.inventoryMenu.getCarried().isEmpty())throw error("BUSY","The cursor holds an item");
        if(crafting)beginCraft();else beginSmelt();
    }
    /** Failure details for a thrown refusal (code added by the caller). */
    JsonObject detail(){JsonObject result=failureDetail==null?new JsonObject():failureDetail.deepCopy();if(skipped.size()>0)result.add("skipped",skipped);return result;}
    private static int integer(JsonObject args,String key,int fallback,int min,int max) {
        double value=bounded(args,key,fallback,min,max);
        if(value!=Math.rint(value))throw error("INVALID_ARGUMENT",key+" must be an integer");
        return (int)value;
    }
    private static long now(){return System.nanoTime()/1_000_000;}

    // ---------- craft ----------
    private void beginCraft() {
        JsonObject args=operation.args;wanted=item(string(args,"item"));count=integer(args,"count",1,1,256);
        deadline=now()+(long)bounded(args,"timeoutMs",30_000,1000,120_000);
        plans=NativeWorkstation.plans(player,wanted);
        if(plans.isEmpty())throw error("NO_RECIPE","No ordinary crafting recipe makes "+id(wanted));
        Inventory inventory=player.getInventory();
        // The body's own 2x2 grid first, when a small recipe can be laid out now.
        for(Plan plan:plans)if(plan.fits(2)&&feasible(plan,inventory,1)>0){craftIn(player.inventoryMenu,2,plan,null);return;}
        Plan table=null;for(Plan plan:plans)if(feasible(plan,inventory,1)>0){table=plan;break;}
        if(table==null)throw missingError();
        for(BlockPos pos:nearby(state->state.is(Blocks.CRAFTING_TABLE)))stations.add(pos);
        if(stations.isEmpty()) {
            BlockPos placed=placeTable();
            if(placed==null)throw error("NO_CRAFTING_TABLE","This recipe needs a crafting table (3x3); none within 16 blocks and none in the inventory to place");
            stations.add(placed);
        }
        next();
    }
    private Protocol.Error missingError() {
        Plan best=null;JsonArray shortest=null;int crafts=(count+plans.getFirst().result().getCount()-1)/plans.getFirst().result().getCount();
        for(Plan plan:plans){JsonArray m=missing(plan,player.getInventory(),crafts);if(shortest==null||m.size()<shortest.size()){best=plan;shortest=m;}}
        failureDetail=obj("recipe",best.id().toString(),"needsTable",!best.fits(2),"missing",shortest);
        return error("MISSING_MATERIALS","Not enough materials for "+id(wanted)+": "+shortest);
    }
    JsonObject failureDetail;
    private void craftIn(AbstractContainerMenu menu,int grid,Plan first,BlockPos table) {
        Inventory inventory=player.getInventory();int perCraft=first.result().getCount();int crafts=(count+perCraft-1)/perCraft,done=0;
        String used=null;
        try {
            for(Plan plan:plans) {
                if(done>=crafts)break;
                if(!plan.fits(grid)||feasible(plan,inventory,1)==0)continue;
                int made=craft(player,menu,grid,plan,crafts-done);
                if(made>0)used=plan.id().toString();
                done+=made;
            }
        } finally { if(menu!=player.inventoryMenu)closeMenu(player); }
        JsonObject result=obj("item",id(wanted),"requestedCount",count,"crafts",done,"made",done*perCraft,"recipe",used,"inventoryChange",delta(before,counts(inventory)));
        if(table!=null)result.add("table",pos(table));
        if(placedTable!=null)result.add("placedTable",pos(placedTable));
        if(done<crafts){
            Plan plan=first;JsonArray short_=missing(plan,inventory,crafts-done);
            result.add("missing",short_);
            if(done==0){result.addProperty("code",short_.isEmpty()?"INVENTORY_FULL":"MISSING_MATERIALS");operation.finish("failed",(short_.isEmpty()?"INVENTORY_FULL":"MISSING_MATERIALS")+": crafted nothing",result);return;}
            operation.finish("succeeded","Crafted "+done*perCraft+" of "+count+"; the rest is short of materials",result);return;
        }
        operation.finish("succeeded","Crafted "+done*perCraft+" "+id(wanted),result);
    }
    private BlockPos placedTable;
    /** Put a crafting table from the inventory down next to the body, like a player would, and remember where. */
    private BlockPos placeTable() {
        Inventory inventory=player.getInventory();int slot=-1;
        for(int i=0;i<36;i++)if(plain(inventory.getItem(i))&&inventory.getItem(i).is(Items.CRAFTING_TABLE)){slot=i;break;}
        if(slot<0)return null;
        BlockPos feet=player.blockPosition();BlockPos target=null;
        outer:
        for(int r=1;r<=2;r++)for(int dx=-r;dx<=r;dx++)for(int dz=-r;dz<=r;dz++){
            if(Math.max(Math.abs(dx),Math.abs(dz))!=r)continue;
            BlockPos at=feet.offset(dx,0,dz);
            if(!player.serverLevel().getBlockState(at).isAir()||!player.serverLevel().getBlockState(at.below()).isFaceSturdy(player.serverLevel(),at.below(),Direction.UP))continue;
            if(new AABB(at).intersects(player.getBoundingBox()))continue;
            if(player.getEyePosition().distanceTo(Vec3.atCenterOf(at))>player.blockInteractionRange()-0.5)continue;
            target=at;break outer;
        }
        if(target==null)throw error("NO_ROOM","No free floor beside the body to put the crafting table down");
        int hotbar=slot;
        if(slot>8){
            hotbar=-1;for(int i=0;i<9;i++)if(inventory.getItem(i).isEmpty()){hotbar=i;break;}
            if(hotbar<0)hotbar=inventory.selected;
            int source=menuSlot(player.inventoryMenu,inventory,slot);
            click(player,player.inventoryMenu,source,hotbar,ClickType.SWAP);
            if(!inventory.getItem(hotbar).is(Items.CRAFTING_TABLE))throw error("UNKNOWN","Could not move the crafting table into the hotbar");
        }
        int previous=inventory.selected;
        player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(hotbar));
        BlockPos support=target.below();Vec3 aim=new Vec3(target.getX()+0.5,target.getY()+0.001,target.getZ()+0.5);
        look(player,aim);
        player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,new BlockHitResult(aim,Direction.UP,support,false),0));
        player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(previous));
        if(!player.serverLevel().getBlockState(target).is(Blocks.CRAFTING_TABLE))throw error("FORBIDDEN","The game refused to place the crafting table");
        placedTable=target.immutable();return placedTable;
    }

    // ---------- smelt ----------
    private void beginSmelt() {
        JsonObject args=operation.args;
        collectOnly=!args.has("input");
        if(!collectOnly){input=item(string(args,"input"));count=integer(args,"count",1,1,64);}
        if(args.has("fuel"))fuel=item(string(args,"fuel"));
        wait=args.has("wait")&&bool(args,"wait");
        deadline=now()+(long)bounded(args,"timeoutMs",wait?600_000:60_000,1000,900_000);
        if(!collectOnly) {
            int have=0;for(int i=0;i<36;i++){ItemStack s=player.getInventory().getItem(i);if(plain(s)&&s.is(input))have+=s.getCount();}
            if(have<count){failureDetail=obj("missing",JsonParser.parseString("[{\"options\":[\""+id(input)+"\"],\"need\":"+count+",\"have\":"+have+"}]"));throw error("MISSING_MATERIALS","Only "+have+" "+id(input)+" in the inventory");}
        }
        if(args.has("furnace")) {
            JsonObject at=object(args,"furnace");BlockPos pos=new BlockPos((int)number(at,"x"),(int)number(at,"y"),(int)number(at,"z"));
            if(!player.serverLevel().hasChunkAt(pos)||cookingType(player.serverLevel().getBlockState(pos))==null)throw error("NOT_A_FURNACE","No furnace, smoker or blast furnace there");
            stations.add(pos);
        } else for(BlockPos pos:nearby(state->{var type=cookingType(state);return type!=null&&(collectOnly||cooking(player,type,new ItemStack(input)).isPresent());}))stations.add(pos);
        if(stations.isEmpty())throw error("NO_FURNACE",collectOnly?"No furnace within 16 blocks":"No furnace, smoker or blast furnace within 16 blocks can cook "+id(input));
        next();
    }
    private void smeltAt(BlockPos pos) {
        AbstractContainerMenu menu=player.containerMenu;
        if(!(menu instanceof AbstractFurnaceMenu))throw error("UNKNOWN","Opened something that is not a furnace");
        Inventory inventory=player.getInventory();
        RecipeType<? extends AbstractCookingRecipe> type=cookingType(player.serverLevel().getBlockState(pos));
        ItemStack inSlot=menu.getSlot(0).getItem();
        if(!collectOnly&&!inSlot.isEmpty()&&!inSlot.is(input)) { closeMenu(player);skipped.add(obj("furnace",pos(pos),"reason","busy with "+id(inSlot)));next();return; }
        ItemStack outSlot=menu.getSlot(2).getItem();
        output=outSlot.isEmpty()?null:outSlot.getItem();
        int taken=takeOutput(menu);
        if(collectOnly) { closeMenu(player);finishSmelt(pos,obj("collected",taken),"Collected "+taken+" from the furnace");return; }
        var recipe=cooking(player,type,new ItemStack(input));
        if(recipe.isEmpty()){closeMenu(player);skipped.add(obj("furnace",pos(pos),"reason","cannot cook "+id(input)));next();return;}
        output=recipe.get().value().getResultItem(player.registryAccess()).getItem();
        int cookTime=recipe.get().value().getCookingTime();
        // Input: from plain stacks, up to the slot's room.
        int room=Math.min(count,input.getDefaultMaxStackSize()-inSlot.getCount()),put=0;
        for(int i=0;i<36&&put<room;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&s.is(input))put+=transfer(player,menu,i,0,room-put);}
        int queued=menu.getSlot(0).getItem().getCount();
        // Fuel: enough burn time for everything queued; a lit furnace's current burn is not counted (at most one item extra).
        ItemStack fuelSlot=menu.getSlot(1).getItem();
        int needTicks=queued*cookTime-(fuelSlot.isEmpty()?0:fuelSlot.getCount()*fuelSlot.getBurnTime(type)),fuelPut=0;
        String fuelId=fuelSlot.isEmpty()?null:id(fuelSlot);int perFuel=fuelSlot.isEmpty()?0:fuelSlot.getBurnTime(type);
        if(needTicks>0) {
            int best=-1;
            if(fuelSlot.isEmpty()) {
                int bestRank=Integer.MAX_VALUE;
                for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);int rank=fuel!=null?(plain(s)&&s.is(fuel)&&s.getBurnTime(type)>0?0:-1):fuelRank(s,input,type);if(rank>=0&&rank<bestRank){bestRank=rank;best=i;}}
            } else for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&ItemStack.isSameItemSameComponents(s,fuelSlot)){best=i;break;}}
            if(best>=0) {
                Item kind=inventory.getItem(best).getItem();perFuel=inventory.getItem(best).getBurnTime(type);fuelId=id(kind);
                int wantFuel=(needTicks+perFuel-1)/perFuel;
                for(int i=0;i<36&&fuelPut<wantFuel;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&s.is(kind))fuelPut+=transfer(player,menu,i,1,wantFuel-fuelPut);}
            }
        }
        ItemStack fuelNow=menu.getSlot(1).getItem();
        int coveredTicks=fuelNow.isEmpty()?0:fuelNow.getCount()*fuelNow.getBurnTime(type);
        boolean lit=((AbstractFurnaceMenu)menu).isLit();
        int coveredItems=Math.min(queued,cookTime<=0?queued:coveredTicks/cookTime+(lit?1:0));
        loaded=obj("furnace",pos(pos),"type",BuiltInRegistries.BLOCK.getKey(player.serverLevel().getBlockState(pos).getBlock()).toString(),"input",id(input),"added",put,"queued",queued,
            "output",id(output),"cookSeconds",cookTime/20.0,"readyInSeconds",queued*cookTime/20.0,"fuel",fuelId,"fuelAdded",fuelPut,"coveredByFuel",coveredItems);
        if(taken>0)loaded.addProperty("collectedBefore",taken);
        collected=taken;
        if(put==0&&queued==0){closeMenu(player);finishSmelt(pos,loaded,"Nothing was put in");return;}
        if(coveredItems<queued&&!lit)loaded.addProperty("fuelShortItems",queued-coveredItems);
        if(coveredItems==0&&!lit){closeMenu(player);loaded.addProperty("code","NO_FUEL");operation.finish("failed","NO_FUEL: the input is in the furnace but there is no fuel for it",withChange(loaded));station=null;return;}
        if(!wait){closeMenu(player);finishSmelt(pos,loaded,"Loaded "+put+" "+id(input)+"; ready in about "+Math.round(queued*cookTime/20.0)+" s; come back with smelt-item collect");return;}
        furnace=menu;expectedOutput=coveredItems;waitUntil=Math.min(deadline,now()+(long)(queued*cookTime*50L)+10_000);
    }
    private int takeOutput(AbstractContainerMenu menu) {
        ItemStack out=menu.getSlot(2).getItem();if(out.isEmpty())return 0;
        Item kind=out.getItem();int beforeCount=total(player.getInventory(),kind);
        quickMove(player,menu,2);
        return total(player.getInventory(),kind)-beforeCount;
    }
    private JsonObject withChange(JsonObject result){result.add("inventoryChange",delta(before,counts(player.getInventory())));if(skipped.size()>0)result.add("skipped",skipped);return result;}
    private void finishSmelt(BlockPos pos,JsonObject result,String summary){operation.finish("succeeded",summary,withChange(result));station=null;}
    private void tickWait() {
        if(player.containerMenu!=furnace||!furnace.stillValid(player))throw error("STALE_CONTAINER","The furnace closed while waiting");
        // Take output as it comes so the slot never fills up.
        collected+=takeOutput(furnace);
        boolean done=collected>=expectedOutput||furnace.getSlot(0).getItem().isEmpty()&&!((AbstractFurnaceMenu)furnace).isLit();
        if(!done&&now()<waitUntil)return;
        collected+=takeOutput(furnace);
        closeMenu(player);
        loaded.addProperty("collected",collected);loaded.addProperty("leftInFurnace",furnace.getSlot(0).getItem().getCount());
        finishSmelt(station,loaded,done?"Smelted and collected "+collected+" "+id(output):"Waited "+(waitUntil>=deadline?"until the time limit":"the expected time")+"; collected "+collected+" so far");
    }

    // ---------- walking and opening ----------
    private List<BlockPos> nearby(java.util.function.Predicate<BlockState> wantedBlock) {
        List<BlockPos> found=new ArrayList<>();BlockPos origin=player.blockPosition();
        for(int x=-SEARCH;x<=SEARCH;x++)for(int z=-SEARCH;z<=SEARCH;z++){
            if(x*x+z*z>SEARCH*SEARCH)continue;
            for(int y=-VERTICAL;y<=VERTICAL;y++){
                BlockPos pos=origin.offset(x,y,z);if(player.serverLevel().isOutsideBuildHeight(pos))continue;
                var chunk=player.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);if(chunk==null)continue;
                if(wantedBlock.test(chunk.getBlockState(pos)))found.add(pos.immutable());
            }
        }
        found.sort(Comparator.comparingDouble(p->Vec3.atCenterOf(p).distanceToSqr(player.position())));
        return found.subList(0,Math.min(found.size(),6));
    }
    private void next() {
        station=stations.poll();navigation=null;
        if(station==null){
            JsonObject result=withChange(obj("code",crafting?"NO_CRAFTING_TABLE":"NO_FURNACE"));
            operation.finish("failed",(crafting?"NO_CRAFTING_TABLE":"NO_FURNACE")+": no usable workstation nearby",result);return;
        }
        if(Vec3.atCenterOf(station).distanceTo(player.position())>32)throw error("OUT_OF_REACH","Workstation is more than 32 blocks away");
    }
    boolean waiting(){return furnace!=null;}
    void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(now()>=deadline&&furnace==null)throw error("TIMEOUT","Workstation task time limit reached");
        if(furnace!=null){tickWait();return;}
        if(station==null)return;
        BlockState state=player.serverLevel().getBlockState(station);
        if(crafting?!state.is(Blocks.CRAFTING_TABLE):cookingType(state)==null){skipped.add(obj("at",pos(station),"reason","gone"));next();return;}
        FlatApproach geometry=new FlatApproach(player);BlockPos target=station;
        if(!(player.onGround()&&geometry.containerReach(player.position(),target))) {
            if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation);}
            try { if(!navigation.tick(Vec3.atCenterOf(target),feet->geometry.containerReach(feet,target)))return; }
            catch(Protocol.Error failure){ if(failure.code.equals("NO_PATH")||failure.code.equals("BLOCKED")&&!failure.getMessage().contains("damage")){skipped.add(obj("at",pos(target),"reason",failure.code));navigation.stop();next();return;} throw failure; }
            navigation.stop();navigation=null;
        }
        player.stopInput();
        use(player,target);
        if(crafting) {
            if(!(player.containerMenu instanceof CraftingMenu menu)){closeMenu(player);skipped.add(obj("at",pos(target),"reason","did not open"));next();return;}
            Plan plan=null;for(Plan p:plans)if(feasible(p,player.getInventory(),1)>0){plan=p;break;}
            if(plan==null){closeMenu(player);throw missingError();}
            craftIn(menu,3,plan,target);station=null;
        } else {
            if(player.containerMenu==player.inventoryMenu){skipped.add(obj("at",pos(target),"reason","did not open"));next();return;}
            smeltAt(target);
        }
    }
    void stop() {
        if(navigation!=null)navigation.stop();navigation=null;
        try{closeMenu(player);}catch(RuntimeException ignored){}
        furnace=null;station=null;
    }
}
