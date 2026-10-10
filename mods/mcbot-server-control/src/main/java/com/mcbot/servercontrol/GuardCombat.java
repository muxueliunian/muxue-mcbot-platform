package com.mcbot.servercontrol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.*;
import net.minecraft.world.entity.animal.AbstractGolem;
import net.minecraft.world.entity.animal.allay.Allay;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.entity.monster.*;
import net.minecraft.world.entity.npc.Npc;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.*;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Companion guard, ticked by a running follow: fight hostiles that come near the companion player instead of
 * only hitting back. Melee in reach, a bow at range (never through a player or a pet), a raised shield while
 * waiting for the swing or backing off, and a retreat toward the player when health runs low. It runs (sprints) to a
 * foe and away from one, so a skeleton backing off cannot keep it at bow range. It never chases
 * beyond the leash around the player; when nothing needs fighting the follow carries on as before.
 */
final class GuardCombat {
    static final double MELEE_RANGE=3.2,BOW_MIN=4,BOW_CHASE=8,BOW_MAX=24,BOOM_SAFE=5,RETREAT_SPAN=5;
    static final int FULL_DRAW=20,MAX_DRAW=80;
    static final long NO_PATH_MS=5000,STALE_FIGHT_MS=15000,KILL_WINDOW_MS=3000;
    record Options(double radius,double leash,float lowHealth,boolean bow,boolean shield) {
        static Options parse(JsonElement value) {
            if(value==null||value.isJsonNull())return null;
            if(value.isJsonPrimitive()&&value.getAsJsonPrimitive().isBoolean())return value.getAsBoolean()?parse(new JsonObject()):null;
            if(!value.isJsonObject())throw error("INVALID_ARGUMENT","guard must be a boolean or an object");
            JsonObject args=value.getAsJsonObject();
            double radius=bounded(args,"radius",8,3,12);
            float low=(float)bounded(args,"lowHealth",8,4,16);
            boolean bow=!args.has("bow")||bool(args,"bow"),shield=!args.has("shield")||bool(args,"shield");
            return new Options(radius,Math.min(16,radius+4),low,bow,shield);
        }
        JsonObject json(){return obj("radius",radius,"leash",leash,"lowHealth",lowHealth,"bow",bow,"shield",shield);}
    }
    /** One living thing worth fighting, with the native facts the decisions need. */
    record Foe(Object identity,String id,String type,Vec3 position,double distance,double companionDistance,
               boolean targetingCompanion,boolean targetingSelf,boolean ranged,boolean creeper,boolean explosionPreparing,boolean flying,boolean visible) {}
    interface View {
        long now();
        Vec3 position();
        float health();
        /** Eligible foes only: hostile or attacking the companion or the body, never a player or a pet. */
        List<Foe> foes(Vec3 companion,double radius);
        boolean dead(Foe foe);
        boolean inReach(Foe foe);
        /** One walking tick toward melee reach, staying within the leash; throws when there is no way. */
        boolean approach(Foe foe,Vec3 companion,double leash);
        /** One walking tick toward a safer spot, staying within the leash; throws when there is no way. */
        boolean retreat(Vec3 destination,Vec3 companion,double leash);
        void stopMoving();
        /** Best verified melee weapon (or a bare hand, after stowing what is held) selected; false when nothing safe can be held. */
        boolean armMelee();
        boolean cooledDown();
        /** Confirmed damage of one native attack on exactly this foe. */
        float attack(Foe foe);
        boolean hasBow();
        boolean armBow();
        /** Clear line of fire: the foe is visible and no player, pet or villager is near the arrow's path. */
        boolean clearShot(Foe foe);
        /** Ticks the bow has been drawn, or -1. */
        int drawing();
        void draw(Foe foe);
        void release(Foe foe);
        void cancelDraw();
        boolean armShield();
        void raiseShield(Foe foe);
        void lowerShield();
    }
    private final View view;
    private final GuardExecution execution;
    final Options options;
    private Foe target,lastHitFoe;
    private String state="idle";
    private final Map<Object,Long> noPath=new HashMap<>();
    private boolean retreating;
    /** Why the last melee could not start: the hand could not be emptied (NO_FREE_HAND); cleared once a hand is ready. */
    private String unarmed;
    private long engagedAt,lastHitAt;
    private int hits,kills,shots,retreats;
    private double damage;
    GuardCombat(View view,Options options){this(view,options,new GuardExecution(()->true));}
    private GuardCombat(View view,Options options,GuardExecution execution){this.view=view;this.options=options;this.execution=execution;}
    String state(){return state;}
    JsonObject json() {
        JsonObject result=obj("state",state,"hits",hits,"damage",damage,"shots",shots,"kills",kills,"retreats",retreats,"options",options.json());
        if(target!=null){result.addProperty("target",target.type());result.addProperty("targetId",target.id());}
        if(unarmed!=null)result.addProperty("unarmed",unarmed);
        return result;
    }
    /** True when the guard drove the body this tick; false leaves the tick to the ordinary follow. */
    boolean tick(Vec3 companion) {
        var permission=execution.capture();
        if(!permission.getAsBoolean())return false;
        try {return tick(companion,permission)&&permission.getAsBoolean();}
        catch(Protocol.Error failure){if(!permission.getAsBoolean())return false;throw failure;}
    }
    private static void requireDrive(java.util.function.BooleanSupplier permission){if(!permission.getAsBoolean())throw error("CANCELLED","Guard execution was interrupted");}
    private boolean tick(Vec3 companion,java.util.function.BooleanSupplier permission) {
        long now=view.now();
        noPath.values().removeIf(at->now-at>NO_PATH_MS);
        if(lastHitFoe!=null) {
            if(view.dead(lastHitFoe)){kills++;lastHitFoe=null;}
            else if(now-lastHitAt>KILL_WINDOW_MS)lastHitFoe=null;
        }
        List<Foe> foes=view.foes(companion,options.radius());
        Foe nearest=foes.stream().min(Comparator.comparingDouble(Foe::distance)).orElse(null);
        float health=view.health();
        if(!retreating&&health<=options.lowHealth()&&nearest!=null&&nearest.distance()<=8){retreating=true;retreats++;}
        else if(retreating&&health>=options.lowHealth()+4)retreating=false;
        Foe boom=foes.stream().filter(f->f.explosionPreparing()&&f.distance()<BOOM_SAFE).min(Comparator.comparingDouble(Foe::distance)).orElse(null);
        if(boom!=null||retreating) {
            Foe from=boom!=null?boom:nearest;
            if(from==null||from.distance()>12){settle();return false;}
            backOff(from,companion,boom!=null&&!retreating?"evading":"retreating",permission);
            return true;
        }
        Foe chosen=choose(foes);
        if(chosen==null){settle();return false;}
        if(target==null||target.identity()!=chosen.identity())engagedAt=now;
        target=chosen;
        // A fight that lands nothing for a long time (the foe hides behind a wall, keeps out of reach) is let go.
        if(now-engagedAt>STALE_FIGHT_MS&&now-Math.max(lastHitAt,engagedAt)>STALE_FIGHT_MS){noPath.put(chosen.identity(),now);settle();return false;}
        boolean melee=chosen.distance()<=MELEE_RANGE&&view.inReach(chosen);
        int drawn=view.drawing();
        if(!melee&&shouldShoot(chosen,drawn>=0)&&view.armBow()) {
            requireDrive(permission);view.stopMoving();view.lowerShield();
            if(!view.clearShot(chosen)) {
                // Hold the draw while someone stands in the way; give up only after a long wait.
                if(drawn>=0&&drawn<MAX_DRAW)view.draw(chosen);else view.cancelDraw();
                requireDrive(permission);state="aiming";return true;
            }
            if(drawn<0)view.draw(chosen);
            else if(drawn>=FULL_DRAW){view.release(chosen);shots++;lastHitFoe=chosen;lastHitAt=now;}
            else view.draw(chosen);
            requireDrive(permission);state="shooting";return true;
        }
        requireDrive(permission);view.cancelDraw();
        if(melee) {
            view.stopMoving();
            if(!view.armMelee()){unarmed="NO_FREE_HAND";noPath.put(chosen.identity(),now);settle();return false;}
            unarmed=null;
            requireDrive(permission);
            if(view.cooledDown()) {
                view.lowerShield();
                float dealt=view.attack(chosen);
                if(dealt>0){hits++;damage+=dealt;lastHitFoe=chosen;lastHitAt=now;}
            } else if(options.shield()&&chosen.targetingSelf()&&view.armShield()){requireDrive(permission);view.raiseShield(chosen);}
            requireDrive(permission);state="fighting";return true;
        }
        if(chosen.flying()){settle();return false;} // nothing to walk to; wait for it to swoop into reach
        view.lowerShield();
        try {view.approach(chosen,companion,options.leash());}
        catch(Protocol.Error blocked){noPath.put(chosen.identity(),now);view.stopMoving();settle();return false;}
        requireDrive(permission);state="approaching";return true;
    }
    private boolean shouldShoot(Foe foe,boolean drawing) {
        if(!options.bow()||!foe.visible()||foe.distance()>BOW_MAX||!view.hasBow())return false;
        if(drawing)return foe.distance()>MELEE_RANGE;
        if(foe.distance()<BOW_MIN)return false;
        return foe.ranged()||foe.creeper()||foe.flying()||noPath.containsKey(foe.identity())||foe.distance()>=BOW_CHASE;
    }
    /** Keep the current foe while it is still eligible; otherwise whoever threatens the companion first, then the nearest. */
    private Foe choose(List<Foe> foes) {
        boolean bow=options.bow()&&view.hasBow();
        List<Foe> able=foes.stream().filter(f->!noPath.containsKey(f.identity())||bow&&f.visible()).toList();
        if(target!=null)for(Foe foe:able)if(foe.identity()==target.identity())return foe;
        return able.stream().min(Comparator.comparing((Foe f)->!f.targetingCompanion()).thenComparing(f->!f.targetingSelf()).thenComparingDouble(Foe::companionDistance)).orElse(null);
    }
    private void backOff(Foe from,Vec3 companion,String next,java.util.function.BooleanSupplier permission) {
        view.cancelDraw();target=null;
        if(options.shield()&&view.armShield()){requireDrive(permission);view.raiseShield(from);}
        requireDrive(permission);
        try {view.retreat(retreatPoint(view.position(),from.position(),companion,options.leash()),companion,options.leash());}
        catch(Protocol.Error blocked){view.stopMoving();}
        requireDrive(permission);state=next;
    }
    /** Toward the player when that is away from the foe; otherwise straight away from it, kept inside the leash. */
    static Vec3 retreatPoint(Vec3 feet,Vec3 foe,Vec3 companion,double leash) {
        Vec3 flatFoe=new Vec3(foe.x,feet.y,foe.z),flatCompanion=new Vec3(companion.x,feet.y,companion.z);
        if(flatCompanion.distanceTo(flatFoe)>feet.distanceTo(flatFoe)+1)return companion;
        Vec3 away=feet.subtract(flatFoe);
        if(away.horizontalDistance()<0.001)away=new Vec3(1,0,0);
        Vec3 point=feet.add(new Vec3(away.x,0,away.z).normalize().scale(RETREAT_SPAN));
        Vec3 leashed=point.subtract(flatCompanion);
        return leashed.horizontalDistance()<=leash-1?point:flatCompanion.add(new Vec3(leashed.x,0,leashed.z).normalize().scale(leash-1));
    }
    private void settle(){view.cancelDraw();view.lowerShield();target=null;state="idle";}
    void stop(){execution.interrupt();try{view.cancelDraw();view.lowerShield();}finally{view.stopMoving();target=null;state="idle";}}

    /** Full-power arrow pitch (Minecraft sign: negative looks up) that crosses `horizontal` blocks at `dy` above the launch point, or NaN. */
    static double arrowPitch(double horizontal,double dy) {
        double lo=Math.toRadians(-45),hi=Math.toRadians(45);
        if(Double.isNaN(arrowHeight(hi,horizontal))||arrowHeight(hi,horizontal)<dy)return Double.NaN;
        for(int i=0;i<40;i++){double mid=(lo+hi)/2,h=arrowHeight(mid,horizontal);if(Double.isNaN(h)||h<dy)lo=mid;else hi=mid;}
        return -Math.toDegrees(hi);
    }
    /** Vanilla arrow flight: move by the velocity, then 0.99 drag and 0.05 gravity per tick, launched at 3 blocks per tick. */
    static double arrowHeight(double angle,double horizontal) {
        double vx=3*Math.cos(angle),vy=3*Math.sin(angle),x=0,y=0;
        for(int t=0;t<100&&vx>0.01;t++){
            if(x+vx>=horizontal)return y+vy*(horizontal-x)/vx;
            x+=vx;y+=vy;vx*=0.99;vy=vy*0.99-0.05;
        }
        return Double.NaN;
    }
    /** Distance from a point to the segment from `a` to `b`. */
    static double segmentDistance(Vec3 point,Vec3 a,Vec3 b) {
        Vec3 ab=b.subtract(a);double length=ab.lengthSqr();
        double t=length<1e-9?0:Math.max(0,Math.min(1,point.subtract(a).dot(ab)/length));
        return point.distanceTo(a.add(ab.scale(t)));
    }

    /** Tag put on every projectile the body looses; it outlives the body, so an arrow in flight after a logout stays harmless to players and pets. */
    static final String BODY_PROJECTILE_TAG="mcbot_body_projectile";
    /** Cancel damage that comes from the body (its own hit, or a tagged projectile) onto a protected victim other than the body itself. */
    static boolean blocksFriendlyFire(boolean sourceIsBody,boolean directIsBodyProjectile,boolean victimIsBody,boolean victimProtected) {
        return (sourceIsBody||directIsBodyProjectile)&&!victimIsBody&&victimProtected;
    }
    /** Players, anything tamed or named, leashed animals, villagers, golems that are not monsters, allays and armor stands. */
    static boolean protectedEntity(Entity entity) {
        if(entity instanceof Player||entity instanceof ArmorStand||entity instanceof Npc||entity instanceof Allay)return true;
        if(entity instanceof AbstractGolem&&!(entity instanceof Enemy))return true;
        if(entity instanceof OwnableEntity owned&&owned.getOwnerUUID()!=null)return true;
        if(entity instanceof Leashable leashed&&leashed.isLeashed())return true;
        return entity.hasCustomName();
    }
    /** Loaded on first item check only: the component registry needs a bootstrapped game. */
    private static final class Known {
        static final Set<DataComponentType<?>> WEAPON=Set.of(DataComponents.DAMAGE,DataComponents.CUSTOM_NAME,DataComponents.LORE,DataComponents.REPAIR_COST,DataComponents.ENCHANTMENTS);
        static final Set<DataComponentType<?>> SHIELD=Set.of(DataComponents.DAMAGE,DataComponents.CUSTOM_NAME,DataComponents.LORE,DataComponents.REPAIR_COST,DataComponents.ENCHANTMENTS,DataComponents.BANNER_PATTERNS,DataComponents.BASE_COLOR);
    }
    private static final List<String> TIERS=List.of("netherite","diamond","iron","stone","golden","wooden");
    /** Vanilla item and class, only known data components, only vanilla enchantments, some durability left. */
    private static boolean verified(ItemStack stack,Class<?> kind,Set<DataComponentType<?>> allowed) {
        if(stack.isEmpty()||!kind.isInstance(stack.getItem())||!BuiltInRegistries.ITEM.getKey(stack.getItem()).getNamespace().equals("minecraft")||!stack.getItem().getClass().getName().startsWith("net.minecraft."))return false;
        for(var entry:stack.getComponentsPatch().entrySet())if(!allowed.contains(entry.getKey()))return false;
        for(var enchantment:stack.getEnchantments().keySet())if(!enchantment.unwrapKey().map(key->key.location().getNamespace().equals("minecraft")).orElse(false))return false;
        return !stack.isDamageableItem()||stack.getMaxDamage()-stack.getDamageValue()>4;
    }
    /** How to get a hand ready for melee: hold that slot, keep what is held, or stow the held stack into that main inventory slot; none when every slot is full. */
    enum Arm {HOLD,READY,STOW,NONE}
    record Arming(Arm arm,int slot) {}
    /**
     * Prefers the best verified weapon (bestWeapon, -1 when none; better: it beats the held one), then an empty hotbar
     * slot, then moving the held stack into an empty main inventory slot (9..35) so the bare hand fights. An unverified
     * or modded stack is never swung, only moved aside.
     */
    static Arming arming(int selected,boolean heldWeapon,boolean heldEmpty,int bestWeapon,boolean better,java.util.function.IntPredicate empty) {
        if(bestWeapon>=0&&(!heldWeapon||better))return new Arming(Arm.HOLD,bestWeapon);
        if(heldWeapon||heldEmpty)return new Arming(Arm.READY,selected);
        for(int i=0;i<9;i++)if(empty.test(i))return new Arming(Arm.HOLD,i);
        for(int i=9;i<36;i++)if(empty.test(i))return new Arming(Arm.STOW,i);
        return new Arming(Arm.NONE,-1);
    }
    static boolean meleeWeapon(ItemStack stack){return verified(stack,SwordItem.class,Known.WEAPON)||verified(stack,AxeItem.class,Known.WEAPON);}
    /** Lower is better: swords before axes (faster swings), better material first. */
    static int weaponRank(ItemStack stack) {
        String path=BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
        int tier=TIERS.indexOf(path.substring(0,Math.max(0,path.indexOf('_'))));
        return (stack.getItem() instanceof SwordItem?0:10)+(tier<0?9:tier);
    }
    static boolean bow(ItemStack stack) {
        // Flame arrows can light TNT and campfires; that is not part of guarding.
        return verified(stack,BowItem.class,Known.WEAPON)&&stack.getEnchantments().keySet().stream().noneMatch(e->e.is(net.minecraft.world.item.enchantment.Enchantments.FLAME));
    }
    static boolean shield(ItemStack stack){return verified(stack,ShieldItem.class,Known.SHIELD);}

    static GuardCombat create(BodyPlayer body,ControlSession session,ControlSession.Operation operation,MinecraftServer server,String companionName,Options options) {
        return create(body,()->session.mayDrive(operation),server,companionName,options);
    }
    /** mayDrive: whether the guard may still move and swing (the follow operation is running, or the guard duty's lease is live). */
    static GuardCombat create(BodyPlayer body,java.util.function.BooleanSupplier mayDrive,MinecraftServer server,String companionName,Options options) {
        GuardExecution execution=new GuardExecution(mayDrive);
        View view=new View() {
            NativeNavigation approach,retreat;Object approaching;
            int sequence;
            ServerPlayer companion(){return server.getPlayerList().getPlayerByName(companionName);}
            LivingEntity living(Foe foe){return (LivingEntity)foe.identity();}
            public long now(){return System.nanoTime()/1_000_000;}
            public Vec3 position(){return body.position();}
            public float health(){return body.getHealth();}
            public List<Foe> foes(Vec3 centre,double radius) {
                ServerPlayer player=companion();
                if(player==null)return List.of();
                AABB area=new AABB(centre,centre).inflate(radius+4).minmax(body.getBoundingBox().inflate(8));
                List<Foe> result=new ArrayList<>();
                for(LivingEntity entity:body.serverLevel().getEntitiesOfClass(LivingEntity.class,area,e->e!=body&&e.isAlive()&&!e.isRemoved())) {
                    if(protectedEntity(entity)||entity.distanceTo(body)>BOW_MAX)continue;
                    Mob mob=entity instanceof Mob m?m:null;
                    boolean targetingCompanion=mob!=null&&mob.getTarget()==player||recent(player,entity);
                    boolean targetingSelf=mob!=null&&mob.getTarget()==body||recent(body,entity);
                    double companionDistance=entity.distanceTo(player),distance=entity.distanceTo(body);
                    boolean near=companionDistance<=radius||targetingCompanion&&companionDistance<=radius+4||targetingSelf&&distance<=8;
                    if(!near||!(ThreatSense.vanillaHostile(entity)||targetingCompanion||targetingSelf))continue;
                    String type=BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
                    boolean ranged=entity instanceof RangedAttackMob||entity instanceof Blaze||entity instanceof Ghast||entity instanceof Shulker;
                    boolean flying=entity instanceof FlyingMob||entity instanceof Blaze||entity instanceof Vex;
                    result.add(new Foe(entity,entity.getUUID().toString(),type,entity.position(),distance,companionDistance,targetingCompanion,targetingSelf,
                        ranged,entity instanceof Creeper,ThreatSense.explosionPreparing(entity),flying,body.hasLineOfSight(entity)));
                }
                return result;
            }
            boolean recent(ServerPlayer victim,LivingEntity attacker){int age=victim.tickCount-victim.getLastHurtByMobTimestamp();return victim.getLastHurtByMob()==attacker&&age>=0&&age<=100;}
            public boolean dead(Foe foe){return !living(foe).isAlive();}
            public boolean inReach(Foe foe){LivingEntity e=living(foe);return body.canInteractWithEntity(e,0)&&body.hasLineOfSight(e);}
            public boolean approach(Foe foe,Vec3 centre,double leash) {
                if(approaching!=foe.identity()||approach==null){if(approach!=null)approach.stop();approach=new NativeNavigation(body,execution.capture()).tolerateDamage().sprint();approaching=foe.identity();}
                if(retreat!=null){retreat.stop();retreat=null;}
                LivingEntity e=living(foe);
                return approach.tick(e.position(),feet->feet.distanceTo(e.position())<=2.4,feet->feet.distanceTo(centre)<=leash);
            }
            public boolean retreat(Vec3 destination,Vec3 centre,double leash) {
                if(approach!=null){approach.stop();approach=null;approaching=null;}
                if(retreat==null)retreat=new NativeNavigation(body,execution.capture()).tolerateDamage().sprint();
                return retreat.tick(destination,feet->feet.distanceTo(destination)<=1.2,feet->feet.distanceTo(centre)<=leash+1);
            }
            public void stopMoving() {
                if(approach!=null){approach.stop();approach=null;approaching=null;}
                if(retreat!=null){retreat.stop();retreat=null;}
                body.stopInput();
            }
            /** Bring the stack in `slot` into the hotbar (swapping with an empty slot first, else the selected one) and select it. */
            boolean hold(int slot) {
                var permission=execution.capture();requireDrive(permission);
                if(body.containerMenu!=body.inventoryMenu||!body.inventoryMenu.getCarried().isEmpty())return false;
                int hotbar=slot;
                if(slot>8) {
                    hotbar=body.getInventory().selected;
                    for(int i=0;i<9;i++)if(body.getInventory().getItem(i).isEmpty()){hotbar=i;break;}
                    int menu=NativeWorkstation.menuSlot(body.inventoryMenu,body.getInventory(),slot);
                    if(menu<0)return false;
                    if(body.isUsingItem())body.stopUsingItem();
                    NativeWorkstation.click(body,body.inventoryMenu,menu,hotbar,ClickType.SWAP);
                    requireDrive(permission);
                }
                if(body.getInventory().selected!=hotbar){if(body.isUsingItem())body.stopUsingItem();body.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(hotbar));}
                return body.getInventory().selected==hotbar;
            }
            int best(java.util.function.Predicate<ItemStack> kind,Comparator<ItemStack> order) {
                int found=-1;
                for(int i=0;i<36;i++){ItemStack stack=body.getInventory().getItem(i);if(kind.test(stack)&&(found<0||order.compare(stack,body.getInventory().getItem(found))<0||order.compare(stack,body.getInventory().getItem(found))==0&&i==body.getInventory().selected))found=i;}
                return found;
            }
            public boolean armMelee() {
                ItemStack held=body.getMainHandItem();
                int slot=best(GuardCombat::meleeWeapon,Comparator.comparingInt(GuardCombat::weaponRank));
                boolean heldWeapon=meleeWeapon(held);
                Arming plan=arming(body.getInventory().selected,heldWeapon,held.isEmpty(),slot,slot>=0&&heldWeapon&&weaponRank(body.getInventory().getItem(slot))<weaponRank(held),i->body.getInventory().getItem(i).isEmpty());
                return switch(plan.arm()) {
                    case HOLD -> hold(plan.slot());
                    case READY -> true;
                    case STOW -> stow(plan.slot());
                    case NONE -> false;
                };
            }
            /** Move the held stack into the empty main inventory slot `slot` (the same native SWAP as hold()), leaving the hand bare. */
            boolean stow(int slot) {
                var permission=execution.capture();requireDrive(permission);
                if(body.containerMenu!=body.inventoryMenu||!body.inventoryMenu.getCarried().isEmpty()||!body.getInventory().getItem(slot).isEmpty())return false;
                int menu=NativeWorkstation.menuSlot(body.inventoryMenu,body.getInventory(),slot);
                if(menu<0)return false;
                if(body.isUsingItem())body.stopUsingItem();
                NativeWorkstation.click(body,body.inventoryMenu,menu,body.getInventory().selected,ClickType.SWAP);
                requireDrive(permission);
                return body.getMainHandItem().isEmpty();
            }
            public boolean cooledDown(){return body.getAttackStrengthScale(0.5f)>=1f;}
            public float attack(Foe foe) {
                LivingEntity e=living(foe);String id=foe.id();float[] dealt={0};RuntimeException[] refused={null};
                var permission=execution.capture();requireDrive(permission);
                NativeAttackScope scope=new NativeAttackScope() {
                    public boolean allowNativeTarget(String targetId){return id.equals(targetId)&&permission.getAsBoolean()&&!protectedEntity(e);}
                    public void refuseNative(RuntimeException failure){if(refused[0]==null)refused[0]=failure;}
                    public void receipt(String targetId,float amount){if(id.equals(targetId)&&Float.isFinite(amount)&&amount>0)dealt[0]+=amount;}
                };
                look(e.getEyePosition());
                SurvivalActions.scopedAttack(body,scope,()->body.attack(e));
                if(permission.getAsBoolean())body.swing(InteractionHand.MAIN_HAND,true);
                return refused[0]==null?dealt[0]:0;
            }
            public boolean hasBow(){return best(GuardCombat::bow,(a,b)->0)>=0&&!body.getProjectile(body.getInventory().getItem(best(GuardCombat::bow,(a,b)->0))).isEmpty();}
            public boolean armBow() {
                if(bow(body.getMainHandItem()))return !body.getProjectile(body.getMainHandItem()).isEmpty();
                int slot=best(GuardCombat::bow,(a,b)->0);
                return slot>=0&&hold(slot)&&!body.getProjectile(body.getMainHandItem()).isEmpty();
            }
            public boolean clearShot(Foe foe) {
                LivingEntity e=living(foe);
                if(!body.hasLineOfSight(e))return false;
                Vec3 from=body.getEyePosition(),to=e.getBoundingBox().getCenter();
                Vec3 past=to.add(to.subtract(from).normalize().scale(4)); // an arrow that misses keeps flying
                for(Entity other:body.serverLevel().getEntities(body,new AABB(from,past).inflate(2)))
                    if(other!=e&&protectedEntity(other)&&segmentDistance(other.getBoundingBox().getCenter(),from,past)<other.getBbWidth()/2+1.2)return false;
                return true;
            }
            public int drawing(){return body.isUsingItem()&&body.getUseItem().getItem() instanceof BowItem?body.getTicksUsingItem():-1;}
            void aim(LivingEntity e) {
                Vec3 eye=body.getEyePosition().subtract(0,0.1,0),centre=e.getBoundingBox().getCenter();
                double ticks=Math.sqrt(Math.pow(centre.x-eye.x,2)+Math.pow(centre.z-eye.z,2))/2.8;
                Vec3 lead=centre.add(e.getDeltaMovement().x*ticks,0,e.getDeltaMovement().z*ticks);
                double dx=lead.x-eye.x,dz=lead.z-eye.z,horizontal=Math.sqrt(dx*dx+dz*dz);
                double pitch=arrowPitch(horizontal,lead.y-eye.y);
                float yaw=(float)Math.toDegrees(Math.atan2(-dx,dz));
                body.setYRot(yaw);body.setYHeadRot(yaw);body.setXRot((float)(Double.isNaN(pitch)?-45:pitch));
            }
            public void draw(Foe foe) {
                aim(living(foe));
                if(drawing()<0){if(body.isUsingItem())body.stopUsingItem();body.connection.handleUseItem(new ServerboundUseItemPacket(InteractionHand.MAIN_HAND,++sequence,body.getYRot(),body.getXRot()));}
            }
            public void release(Foe foe) {
                aim(living(foe));
                body.connection.handlePlayerAction(new ServerboundPlayerActionPacket(ServerboundPlayerActionPacket.Action.RELEASE_USE_ITEM,BlockPos.ZERO,Direction.DOWN,++sequence));
                if(body.isUsingItem())body.stopUsingItem();
            }
            public void cancelDraw(){if(drawing()>=0)body.stopUsingItem();}
            public boolean armShield() {
                if(shield(body.getOffhandItem()))return true;
                if(!body.getOffhandItem().isEmpty()||body.containerMenu!=body.inventoryMenu||!body.inventoryMenu.getCarried().isEmpty())return false;
                int slot=best(GuardCombat::shield,(a,b)->0);
                if(slot<0)return false;
                int menu=NativeWorkstation.menuSlot(body.inventoryMenu,body.getInventory(),slot);
                if(menu<0)return false;
                NativeWorkstation.click(body,body.inventoryMenu,menu,Inventory.SLOT_OFFHAND,ClickType.SWAP);
                return shield(body.getOffhandItem());
            }
            public void raiseShield(Foe foe) {
                look(living(foe).getEyePosition());
                if(!(body.isUsingItem()&&body.getUsedItemHand()==InteractionHand.OFF_HAND)){
                    if(body.isUsingItem())body.stopUsingItem();
                    body.connection.handleUseItem(new ServerboundUseItemPacket(InteractionHand.OFF_HAND,++sequence,body.getYRot(),body.getXRot()));
                }
            }
            public void lowerShield(){if(body.isUsingItem()&&body.getUsedItemHand()==InteractionHand.OFF_HAND)body.stopUsingItem();}
            void look(Vec3 point) {
                Vec3 delta=point.subtract(body.getEyePosition());float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z));
                body.setYRot(yaw);body.setYHeadRot(yaw);body.setXRot((float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance())));
            }
        };
        return new GuardCombat(view,options,execution);
    }
}
